import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createTestServer,
  scratch,
} from "../../../apps/server/test/helpers.js";

type Swatch = { canvas: string | null; primary: string | null };
type Catalog = {
  activeThemeId: string;
  revision: number;
  activeCss: string | null;
  themes: { id: string; name: string; light: Swatch; dark: Swatch }[];
};

const DUSK = `:root, .light { --canvas: #f4f4f4; --primary: var(--brand); --brand: #2e6f95; }
.dark { --canvas: #1a1a1a; }`;

async function themeServer() {
  const server = await createTestServer();
  const directory = join(scratch(), "dusk-theme");
  mkdirSync(directory, { recursive: true });
  const manifest = {
    name: "dusk-theme",
    version: "0.0.1",
    type: "module",
    engines: { bb: "^1" },
    bb: {
      name: "Dusk",
      themes: [{ id: "dusk", name: "Dusk", css: "./dusk.css" }],
    },
  };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "dusk.css"), DUSK);
  const installed = await server.send("/ops/plugins.install", {
    path: directory,
  });
  expect(installed.status).toBe(200);
  const catalog = async () => {
    const response = await server.send("/ops/theme-preview.catalog", {});
    return ((await response.json()) as { result: Catalog }).result;
  };
  return { ...server, directory, catalog };
}

it("lists built-in and plugin themes with swatches read from their CSS", async () => {
  const { catalog } = await themeServer();
  const listed = await catalog();
  expect(listed.activeThemeId).toBe("default");
  expect(listed.activeCss).toBeNull();
  const ids = listed.themes.map(({ id }) => id);
  expect(ids).toEqual(expect.arrayContaining(["default", "nord"]));
  const dusk = listed.themes.find(({ id }) => id === "plugin:dusk-theme:dusk");
  expect(dusk?.name).toBe("Dusk");
  expect(dusk?.light).toMatchObject({ canvas: "#f4f4f4", primary: "#2e6f95" });
  expect(dusk?.dark.canvas).toBe("#1a1a1a");
  const nord = listed.themes.find(({ id }) => id === "nord");
  expect(nord?.dark.canvas).toBeTruthy();
});

it("follows the active theme and bumps the revision when its file is saved", async () => {
  const { catalog, send, directory } = await themeServer();
  const themeId = "plugin:dusk-theme:dusk";
  const chosen = await send(
    "/settings/appearance",
    { themeId, faviconColor: "default" },
    "PUT",
  );
  expect(chosen.status).toBe(200);
  const before = await catalog();
  expect(before.activeThemeId).toBe(themeId);
  expect(before.activeCss).toContain("--brand: #2e6f95");
  const saved = DUSK.replace("#2e6f95", "#aa3355");
  writeFileSync(join(directory, "dusk.css"), saved);
  await vi.waitFor(async () => {
    const after = await catalog();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.activeCss).toContain("#aa3355");
    const dusk = after.themes.find(({ id }) => id === themeId);
    expect(dusk?.light.primary).toBe("#aa3355");
  });
  const { revision } = await catalog();
  writeFileSync(join(directory, "dusk.css"), DUSK);
  await vi.waitFor(async () => {
    expect((await catalog()).revision).toBeGreaterThan(revision);
  });
});
