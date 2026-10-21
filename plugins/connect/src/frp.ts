import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { rootCertificates } from "node:tls";
import { promisify } from "node:util";
import type { Link } from "./account.js";

const VERSION = "0.71.0";
const RELEASES = "https://github.com/fatedier/frp/releases/download";
const ARCHIVES: Record<string, [name: string, sha256: string]> = {
  "linux-x64": [
    "linux_amd64",
    "84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716",
  ],
  "linux-arm64": [
    "linux_arm64",
    "f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266",
  ],
  "darwin-arm64": [
    "darwin_arm64",
    "45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6",
  ],
  "darwin-x64": [
    "darwin_amd64",
    "1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637",
  ],
};
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 10_000;
const ANSI = /\u001b\[[0-9;]*m/gu;

const run = promisify(execFile);

export interface FrpOptions {
  server: string;
  binary?: string;
  dir: string;
  loopbackUrl: string;
  marker: string;
  log: { info(message: string): void; warn(message: string): void };
}

async function downloadClient(dir: string): Promise<string> {
  const target = join(dir, `frpc-${VERSION}`);
  const present = await fs.access(target).then(
    () => true,
    () => false,
  );
  if (present) return target;
  const platform = `${process.platform}-${process.arch}`;
  const archive = ARCHIVES[platform];
  if (archive === undefined) {
    throw new Error(`there is no frp client for ${platform}`);
  }
  const [name, sha256] = archive;
  const folder = `frp_${VERSION}_${name}`;
  const response = await fetch(`${RELEASES}/v${VERSION}/${folder}.tar.gz`);
  if (!response.ok) {
    throw new Error(`the frp download answered HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("the frp download does not match its checksum");
  }
  const packed = join(dir, `${folder}.tar.gz`);
  await fs.writeFile(packed, bytes);
  const member = `${folder}/frpc`;
  await run("tar", ["-xzf", packed, "-C", dir, "--strip-components=1", member]);
  await fs.rm(packed, { force: true });
  await fs.chmod(join(dir, "frpc"), 0o755);
  await fs.rename(join(dir, "frpc"), target);
  return target;
}

export async function trustedCertificates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const certificates = [...rootCertificates];
  const extra = env.NODE_EXTRA_CA_CERTS;
  if (extra !== undefined && extra !== "") {
    certificates.push((await fs.readFile(extra, "utf8")).trim());
  }
  return certificates;
}

export class FrpTunnel {
  private link: Link | null = null;
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private attempt = 0;

  constructor(private readonly options: FrpOptions) {}

  set(link: Link | null): void {
    const same =
      link?.serverLabel === this.link?.serverLabel &&
      link?.credential === this.link?.credential;
    if (same) return;
    this.generation += 1;
    clearTimeout(this.timer);
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.attempt = 0;
    this.link = link;
    if (link !== null) this.start(link, this.generation);
  }

  private start(link: Link, generation: number): void {
    const { warn } = this.options.log;
    const startedAt = Date.now();
    const retry = (reason: string) => {
      if (generation !== this.generation) return;
      const stable = Date.now() - startedAt > STABLE_MS;
      this.attempt = stable ? 0 : this.attempt + 1;
      const delay = Math.min(RETRY_BASE_MS * 2 ** this.attempt, RETRY_MAX_MS);
      warn(`frp: ${reason}; starting again in ${delay}ms`);
      this.timer = setTimeout(() => this.start(link, generation), delay);
    };
    this.launch(link, generation).then(
      (child) => {
        if (child === null) return;
        child.once("error", (error) => retry(error.message));
        child.once("exit", (code) => retry(`the client exited (code ${code})`));
      },
      (error: unknown) => retry(String(error)),
    );
  }

  private async launch(
    link: Link,
    generation: number,
  ): Promise<ChildProcess | null> {
    const { dir, loopbackUrl, marker, log } = this.options;
    const server = new URL(this.options.server);
    const loopback = new URL(loopbackUrl);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const binary = this.options.binary ?? (await downloadClient(dir));
    const roots = join(dir, "roots.pem");
    const secure = server.protocol === "tls:";
    if (secure) {
      const certificates = await trustedCertificates();
      await fs.writeFile(roots, `${certificates.join("\n")}\n`);
    }
    const tls = secure
      ? { enable: true, serverName: server.hostname, trustedCaFile: roots }
      : { enable: false };
    const config = {
      serverAddr: server.hostname,
      serverPort: Number(server.port),
      user: link.serverLabel,
      loginFailExit: false,
      metadatas: { credential: link.credential },
      log: { level: "info", disablePrintColor: true },
      transport: { poolCount: 5, tls },
      proxies: [
        {
          name: "bb",
          type: "http",
          localIP: loopback.hostname,
          localPort: Number(loopback.port),
          subdomain: link.serverLabel,
          hostHeaderRewrite: loopback.host,
          requestHeaders: { set: { "x-bb-via-tunnel": marker } },
        },
      ],
    };
    const file = join(dir, "frpc.json");
    await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
    await fs.chmod(file, 0o600);
    if (generation !== this.generation) return null;
    const child = spawn(binary, ["-c", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        log.info(`frp: ${line.replace(ANSI, "")}`);
      });
    }
    return child;
  }
}
