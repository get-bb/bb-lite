import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { validatePlugin } from "../validate.js";

it("records contract ids, not the local names a plugin gives them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-validate-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "nap-guard", bb: { name: "Nap", app: "app.tsx" } }),
  );
  writeFileSync(
    join(directory, "contract.ts"),
    [
      'import { contract, op } from "@bb/plugin";',
      'export const napGuard = contract("nap-guard", { ping: op() });',
    ].join("\n"),
  );
  writeFileSync(
    join(directory, "app.tsx"),
    [
      "import {",
      "  app as appSlots,",
      '  type AppPlugin } from "@bb/plugin/app";',
      'import { napGuard } from "./contract";',
      "bb.add(appSlots.icon, {});",
      "bb.call(napGuard.ping, {});",
      "bb.call(other.thing, {});",
    ].join("\n"),
  );
  const report = await validatePlugin(directory);
  expect(report.adds.map(({ target }) => target)).toEqual(["app.icon"]);
  expect(report.calls.map(({ target }) => target)).toEqual([
    "nap-guard.ping",
    "other.thing",
  ]);
});
