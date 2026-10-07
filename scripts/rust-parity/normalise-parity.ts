// Applies the replay normalisation described in
// crates/bb-server/tests/fixtures/parity/README.md to a recording directory
// and writes the normalised copy elsewhere, so two recordings (or a TypeScript
// recording and a Rust replay) can be compared with `diff -r`.
//   node --import tsx scripts/rust-parity/normalise-parity.ts <in> <out>
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: normalise-parity <in> <out>");

// Generated ids, each replaced by `<kind>#<n>` in first-seen order:
// - `<prefix>_<10 lowercase alphanumerics>` from newId (thr_, evt_, proj_,
//   env_, sec_, pint_, qmsg_, phist_, src_, creq_, tpv_, ...). Branch names
//   embed the thread id and are covered by the same textual replacement.
// - the echo runner's per-turn key, `<10 hex>` followed by `-t<n>`, `-i<n>`
//   and similar suffixes (turn ids, item ids, call ids); the suffix is kept.
// - UUIDs (provider request ids).
// File modification times (`modifiedAtMs`) are zeroed.
const ID =
  /\b[a-z]{2,8}_[a-z0-9]{10}\b|\b[0-9a-f]{10}(?=-[a-z]+\d)|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const mapping = new Map<string, string>();
const counters = new Map<string, number>();

function canonical(match: string) {
  const known = mapping.get(match);
  if (known !== undefined) return known;
  const kind = match.includes("_")
    ? match.split("_")[0]
    : match.length === 10
      ? "runkey"
      : "uuid";
  const next = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, next);
  const replaced = `${kind}#${next}`;
  mapping.set(match, replaced);
  return replaced;
}

// Timeline cursors are opaque base64url JSON that embed the thread id and the
// workspace path; decode them so the ids inside are normalised too.
const decodeCursor = (_match: string, encoded: string) => {
  const json = Buffer.from(encoded, "base64url")
    .toString("utf8")
    .replace(/\/[^"\\]*\/bb-parity-[A-Za-z0-9]+\/data/g, "$DATA_DIR");
  return `timeline-v3~${JSON.stringify(json).slice(1, -1)}`;
};

const normaliseText = (text: string) =>
  text
    .replace(/timeline-v3:([A-Za-z0-9_-]+)/g, decodeCursor)
    .replace(ID, canonical)
    .replace(/"modifiedAtMs": \d+(\.\d+)?/g, '"modifiedAtMs": 0');

const files = [
  "conversation.json",
  ...readdirSync(join(input, "threads"))
    .sort()
    .map((name) => join("threads", name)),
];
mkdirSync(join(output, "threads"), { recursive: true });
for (const file of files) {
  const text = readFileSync(join(input, file), "utf8");
  writeFileSync(join(output, file), normaliseText(text));
}
writeFileSync(
  join(output, "id-map.json"),
  `${JSON.stringify(Object.fromEntries(mapping), null, 1)}\n`,
);
