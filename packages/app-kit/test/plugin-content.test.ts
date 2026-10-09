import { expect, it } from "vitest";
import {
  defaultFileSource,
  markdownDocumentRouting,
  unifiedPatch,
} from "../lib/plugin-content";

it("gives a bare hunk a file header", () => {
  const hunk = "@@ -1 +1 @@\n-a\n+b";
  expect(unifiedPatch(hunk, "src/x.ts")).toBe(
    `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${hunk}`,
  );
  const full = `--- a/x\n+++ b/x\n${hunk}`;
  expect(unifiedPatch(full)).toBe(full);
});

it("defaults the file source from the path", () => {
  expect(defaultFileSource("/etc/x")).toBe("host");
  expect(defaultFileSource("docs/x.md")).toBe("workspace");
  expect(defaultFileSource("x.md", "thread-storage")).toBe("thread-storage");
});

it("resolves document links and images against the document", () => {
  const opened: string[] = [];
  const routing = markdownDocumentRouting({
    path: "docs/guide.md",
    url: "/api/v1/environments/env/files/docs/guide.md",
    open: (path) => opened.push(path) > 0,
  });
  const image = routing.localImage!;
  expect(
    image.resolveSrc(
      { path: "/docs/img/a b.png", lineRange: null },
      "relative",
    ),
  ).toBe("/api/v1/environments/env/files/docs/img/a%20b.png");
  expect(image.relativePaths).toEqual({ baseDir: "/docs", rootPath: "/" });
  routing.localFile!.onOpenLink({ path: "/README.md", lineRange: null });
  expect(opened).toEqual(["README.md"]);
});

it("keeps host documents absolute", () => {
  const routing = markdownDocumentRouting({
    path: "/store/t/out.md",
    url: "/api/v1/threads/t/host-files/store/t/out.md",
    open: () => true,
  });
  expect(
    routing.localImage!.resolveSrc(
      { path: "/store/t/chart.svg", lineRange: null },
      "relative",
    ),
  ).toBe("/api/v1/threads/t/host-files/store/t/chart.svg");
});
