import { expect, it } from "vitest";
import type { FileViewer } from "@bb/plugin/app";
import { matchesFileViewer } from "../app/lib/file-viewer-match";

const viewer = (extensions: string[], names?: string[]): FileViewer => ({
  id: "v",
  extensions,
  ...(names === undefined ? {} : { names }),
  view: () => null,
});

it("matches viewers by extension or by file name", () => {
  const code = viewer(["ts", "md"], ["Dockerfile", "Makefile"]);
  expect(matchesFileViewer(code, "src/a.TS")).toBe(true);
  expect(matchesFileViewer(code, "deploy/Dockerfile")).toBe(true);
  expect(matchesFileViewer(code, "Makefile")).toBe(true);
  expect(matchesFileViewer(code, "dockerfile")).toBe(false);
  expect(matchesFileViewer(code, "a.py")).toBe(false);
  expect(matchesFileViewer(viewer(["dockerfile"]), "Dockerfile")).toBe(false);
  expect(matchesFileViewer(viewer(["env"]), ".env")).toBe(false);
});
