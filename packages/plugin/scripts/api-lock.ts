import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as machine from "@bb/runner";
import * as app from "../src/app.js";
import * as server from "../src/index.js";
import { describeTypes } from "./type-shapes.js";

const FILE = fileURLToPath(new URL("../api.lock.json", import.meta.url));
const { API_VERSION, compareApi, describeApi, isNewer, majorOf } = server;
const { packApi, unpackApi, withTypes } = server;

const contracts = withTypes(
  describeApi({ ...server, ...app, ...machine }),
  describeTypes(),
);
const rows = (entries: object) =>
  Object.entries(entries).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
const packed = packApi(API_VERSION, contracts);
const groups = Object.entries(packed.contracts).map(
  ([name, members]) =>
    ` ${JSON.stringify(name)}: {\n${rows(members).join(",\n")}\n }`,
);
const text = [
  "{",
  `"version": ${JSON.stringify(API_VERSION)},`,
  `"shapes": {\n${rows(packed.shapes).join(",\n")}\n},`,
  `"contracts": {\n${groups.join(",\n")}\n}`,
  "}\n",
].join("\n");

const rebase = process.argv.includes("--rebase");
if (rebase) console.log("Rewriting the lock without comparing it.");

if (existsSync(FILE) && !rebase) {
  const locked = JSON.parse(readFileSync(FILE, "utf8")) as server.ApiLock;
  const { breaking, additive } = compareApi(unpackApi(locked), contracts);
  const lines = [
    ...breaking.map((change) => `  breaking  ${change}`),
    ...additive.map((change) => `  added     ${change}`),
  ];
  if (lines.length > 0) console.log(lines.join("\n"));
  const major = (version: string) => majorOf(version) ?? 0;
  if (breaking.length > 0 && major(API_VERSION) <= major(locked.version)) {
    console.error(
      `\n${breaking.length} breaking change(s) to the plugin API. Raise the ` +
        `major version in packages/plugin/src/version.ts (now ${API_VERSION}), ` +
        "or keep the old name working with `deprecated` or a door alias.",
    );
    process.exit(1);
  }
  if (additive.length > 0 && !isNewer(API_VERSION, locked.version)) {
    console.error(
      `\nThe plugin API grew. Raise the minor version in ` +
        `packages/plugin/src/version.ts (now ${API_VERSION}).`,
    );
    process.exit(1);
  }
}

writeFileSync(FILE, text);
console.log(`packages/plugin/api.lock.json is at ${API_VERSION}`);
