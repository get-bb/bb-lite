import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

export const PIN = {
  package: "dev-browser",
  version: "1.0.0-rc.3",
  registry: "https://registry.npmjs.org",
  repository: "SawyerHood/dev-browser",
  sha256: {
    "linux-x64":
      "390dd08f8321807bca2e1e060ec031511adb0af002e871dfde3b1f6c8feac914",
    "linux-arm64":
      "8a1d7c80c3bede69809996848526b5ed43cf6f0965d87f99e4349b775f76042e",
    "darwin-x64":
      "76f70f6e8a48c5caf546003e09d9daa4a0cb756d191c4f7fc3c300c2e2935522",
    "darwin-arm64":
      "d68887f7df149915811bf362b208377c2d0d7d500297d4d5977dab129db5b5eb",
  } as Record<string, string>,
};
const MAX_BINARY_BYTES = 400 * 1024 * 1024;
const BINARY = "node_modules/dev-browser/bin/dev-browser-bin";
const RELEASE = `https://github.com/${PIN.repository}/releases/download/v${PIN.version}`;
const HEADERS = { "user-agent": "bb-plugin-browser-automation" };
const run = promisify(execFile);

const verifiedSchema = z.object({
  package: z.literal(PIN.package),
  version: z.literal(PIN.version),
  platform: z.string(),
  sha256: z.string(),
  binary: z.string(),
  installedAt: z.number(),
});

export function pinnedDigest(platform = `${process.platform}-${process.arch}`) {
  const digest = PIN.sha256[platform];
  if (digest === undefined)
    throw new Error(
      `DevBrowser ${PIN.version} has no verified release artifact recorded for ${platform}; see the plugin README before using this host.`,
    );
  return { platform, digest };
}

export function sha256SumFor(sums: string, asset: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] === asset) return match[1]!.toLowerCase();
  }
  return null;
}

const attestations = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: z.object({ dsseEnvelope: z.object({ payload: z.string() }) }),
    }),
  ),
});
const statement = z.object({
  subject: z.array(
    z.object({ name: z.string(), digest: z.object({ sha512: z.string() }) }),
  ),
  predicate: z.object({
    buildDefinition: z.object({
      externalParameters: z.object({
        workflow: z.object({ repository: z.string(), ref: z.string() }),
      }),
    }),
  }),
});

export function checkProvenance(body: unknown, integrity: string): void {
  const slsa = attestations
    .parse(body)
    .attestations.find(
      (a) => a.predicateType === "https://slsa.dev/provenance/v1",
    );
  if (slsa === undefined) throw new Error("DevBrowser has no SLSA provenance");
  const payload = Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64");
  const parsed = statement.parse(JSON.parse(payload.toString("utf8")));
  const sha512 = Buffer.from(
    integrity.replace(/^sha512-/u, ""),
    "base64",
  ).toString("hex");
  const name = `pkg:npm/${PIN.package}@${PIN.version}`;
  if (
    !parsed.subject.some((s) => s.name === name && s.digest.sha512 === sha512)
  )
    throw new Error(
      "DevBrowser provenance does not cover the installed package",
    );
  const { workflow } = parsed.predicate.buildDefinition.externalParameters;
  if (
    workflow.repository !== `https://github.com/${PIN.repository}` ||
    workflow.ref !== `refs/tags/v${PIN.version}`
  )
    throw new Error("DevBrowser provenance names another repository or tag");
}

const fileSha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

export async function verifyInstalled(dir: string, digest: string) {
  try {
    const verified = verifiedSchema.parse(
      JSON.parse(await readFile(join(dir, "verified.json"), "utf8")),
    );
    if (verified.sha256 !== digest || verified.binary.split("/").includes(".."))
      return null;
    const binary = join(dir, verified.binary);
    await access(binary, constants.X_OK);
    return (await fileSha256(binary)) === digest ? binary : null;
  } catch {
    return null;
  }
}

export async function installRuntime(options: {
  dataDir: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<string> {
  const { platform, digest } = pinnedDigest();
  const get = options.fetch ?? fetch;
  const root = join(options.dataDir, "runtime", "npm");
  const final = join(root, `${PIN.package}@${PIN.version}`);
  const existing = await verifyInstalled(final, digest);
  if (existing !== null) return existing;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(
    join(root, `.staging-${PIN.package}@${PIN.version}-`),
  );
  const { signal } = options;
  const npm = (args: string[], timeout: number) =>
    run("npm", [...args, `--registry=${PIN.registry}`], {
      cwd: stage,
      signal,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        npm_config_cache: join(root, "cache"),
        npm_config_ignore_scripts: "true",
        npm_config_update_notifier: "false",
      },
    });
  try {
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify({
        name: "bb-dev-browser-runtime",
        private: true,
        dependencies: { [PIN.package]: PIN.version },
      }),
    );
    await npm(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"],
      600_000,
    );
    const audit = z
      .object({ invalid: z.array(z.unknown()), missing: z.array(z.unknown()) })
      .parse(
        JSON.parse(
          (await npm(["audit", "signatures", "--json"], 120_000)).stdout,
        ),
      );
    if (audit.invalid.length > 0 || audit.missing.length > 0)
      throw new Error("npm registry signatures for DevBrowser did not verify");
    const lock = z
      .object({
        packages: z.record(
          z.string(),
          z.object({
            version: z.string(),
            resolved: z.string(),
            integrity: z.string(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(
            join(stage, "node_modules/.package-lock.json"),
            "utf8",
          ),
        ),
      );
    const entry = lock.packages[`node_modules/${PIN.package}`];
    if (
      entry?.version !== PIN.version ||
      !entry.resolved.startsWith(`${PIN.registry}/`)
    )
      throw new Error("npm installed a different DevBrowser package");
    const proof = await get(
      `${PIN.registry}/-/npm/v1/attestations/${PIN.package}@${PIN.version}`,
      { headers: HEADERS, signal },
    );
    checkProvenance(await proof.json(), entry.integrity);
    const asset = `dev-browser-${platform}`;
    const sums = await (
      await get(`${RELEASE}/SHA256SUMS`, { headers: HEADERS, signal })
    ).text();
    if (sha256SumFor(sums.slice(0, 64_000), asset) !== digest)
      throw new Error("DevBrowser SHA256SUMS does not match the pinned digest");
    const download = await get(`${RELEASE}/${asset}`, {
      headers: HEADERS,
      signal,
    });
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.length > MAX_BINARY_BYTES)
      throw new Error("DevBrowser binary is too large");
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error(
        "Downloaded DevBrowser binary does not match the pinned digest",
      );
    await writeFile(join(stage, BINARY), bytes, { mode: 0o755 });
    const version = await run(join(stage, BINARY), ["--version"], {
      signal,
      timeout: 60_000,
    });
    if (!version.stdout.includes(PIN.version))
      throw new Error("DevBrowser binary reports another version");
    await writeFile(
      join(stage, "verified.json"),
      JSON.stringify({
        package: PIN.package,
        version: PIN.version,
        platform,
        sha256: digest,
        binary: BINARY,
        installedAt: Date.now(),
      }),
    );
    await rm(final, { recursive: true, force: true });
    await rename(stage, final);
    const binary = await verifyInstalled(final, digest);
    if (binary === null)
      throw new Error("DevBrowser runtime failed verification after install");
    return binary;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
