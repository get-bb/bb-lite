import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isBuiltinIconName } from "../src/components/ui/icon";

const PLUGINS = fileURLToPath(new URL("../../../plugins", import.meta.url));
const SKIPPED = new Set(["node_modules", "dist", "test", "templates.ts"]);
const NAMED = [
  /\bicon:\s*"([A-Z]\w+)"/gu,
  /<Icon\s+name="([A-Z]\w+)"/gu,
  /\bglyph:\s*"([A-Z]\w+)"/gu,
];
const REGISTERED = /bb\.add\(app\.icon,\s*\{\s*name:\s*"(\w+)"/gu;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIPPED.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|json)$/u.test(name) ? [path] : [];
  });
}

it("every icon a built-in plugin names is one the app can draw", () => {
  const used = new Map<string, string>();
  const registered = new Set<string>();
  for (const path of sources(PLUGINS)) {
    const text = readFileSync(path, "utf8");
    if (path.endsWith("package.json")) {
      const icon: unknown = JSON.parse(text).bb?.icon;
      if (typeof icon === "string" && /^[A-Z]\w+$/u.test(icon)) {
        used.set(icon, path);
      }
      continue;
    }
    for (const [, name] of text.matchAll(REGISTERED)) registered.add(name);
    for (const pattern of NAMED) {
      for (const [, name] of text.matchAll(pattern)) used.set(name, path);
    }
  }
  const missing = [...used]
    .filter(([name]) => !isBuiltinIconName(name) && !registered.has(name))
    .map(([name, path]) => `${name} (${path.slice(PLUGINS.length + 1)})`);
  expect(missing).toEqual([]);
});
