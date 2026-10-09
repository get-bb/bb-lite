import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  compareApi,
  fail,
  isNewer,
  satisfies,
  unpackApi,
  type ApiLock,
} from "@bb/plugin";
import { z } from "zod";
import type { UpgradeChange, UpgradeReport } from "./contract.js";
import { validatePlugin } from "./validate.js";

const run = promisify(execFile);
const LOCK = "packages/plugin/api.lock.json";

const lockSchema = z.object({
  version: z.string(),
  shapes: z.record(z.string(), z.json()),
  contracts: z.record(z.string(), z.record(z.string(), z.json())),
});

const manifestSchema = z.record(z.string(), z.unknown());
const enginesSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .catch(undefined);
const rangeSchema = z.string().optional().catch(undefined);

export function changesFor(
  used: readonly string[],
  before: ApiLock,
  after: ApiLock,
): UpgradeChange[] {
  const members = new Set(used);
  const contracts = new Set(used.map((name) => name.split(".")[0]));
  const { breaking, additive } = compareApi(
    unpackApi(before),
    unpackApi(after),
  );
  const pick = (kind: UpgradeChange["kind"]) => (line: string) => {
    const split = line.indexOf(": ");
    const member = line.slice(0, split);
    const change = line.slice(split + 2);
    const hit =
      members.has(member) || (contracts.has(member) && !member.includes("."));
    return hit ? [{ member, kind, change }] : [];
  };
  return [
    ...breaking.flatMap(pick("breaking")),
    ...additive.flatMap(pick("additive")),
  ];
}

export function lockFor(
  locks: readonly ApiLock[],
  range: string,
): ApiLock | null {
  const fits = locks.filter(({ version }) => satisfies(version, range));
  return fits.reduce<ApiLock | null>(
    (low, lock) =>
      low === null || isNewer(low.version, lock.version) ? lock : low,
    null,
  );
}

export async function lockHistory(repo: string): Promise<ApiLock[]> {
  const locks = new Map<string, ApiLock>();
  const keep = (text: string) => {
    const lock = lockSchema.parse(JSON.parse(text));
    if (!locks.has(lock.version)) locks.set(lock.version, lock);
  };
  keep(await readFile(join(repo, LOCK), "utf8"));
  const git = (...args: string[]) =>
    run("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const revisions = await git("log", "--format=%H", "--", LOCK).catch(
    () => null,
  );
  for (const revision of revisions?.stdout.split("\n").filter(Boolean) ?? []) {
    keep((await git("show", `${revision}:${LOCK}`)).stdout);
  }
  return [...locks.values()];
}

export async function upgradePlugin(
  directory: string,
  to: string,
  locks: readonly ApiLock[],
): Promise<UpgradeReport> {
  const file = join(directory, "package.json");
  const text = await readFile(file, "utf8").catch(() =>
    fail("not_found", `No package.json in ${directory}`),
  );
  const manifest = manifestSchema.parse(JSON.parse(text));
  const current = enginesSchema.parse(manifest.engines);
  const range = rangeSchema.parse(current?.bb) ?? null;
  const versions = locks.map(({ version }) => version).join(", ");
  const after = locks.find(({ version }) => version === to);
  if (after === undefined) {
    fail("not_found", `No locked plugin API ${to}`, {
      hint: `Known: ${versions}`,
    });
  }
  if (range === null) fail("invalid", "package.json has no engines.bb range");
  const before = lockFor(locks, range);
  if (before === null) {
    fail("not_found", `No locked plugin API matches ${range}`, {
      hint: `Known: ${versions}`,
    });
  }
  const report = await validatePlugin(directory);
  const used = [
    ...report.implements,
    ...report.hooks,
    ...report.calls,
    ...report.emits,
    ...report.adds,
    ...report.wraps,
    ...report.provides,
  ].map(({ target }) => target);
  const next = `^${to}`;
  const engines = { ...current, bb: next };
  await writeFile(
    file,
    `${JSON.stringify({ ...manifest, engines }, null, 2)}\n`,
  );
  return {
    from: before.version,
    to,
    range: { before: range, after: next },
    uses: [...new Set(used)].sort(),
    changes: changesFor(used, before, after),
  };
}
