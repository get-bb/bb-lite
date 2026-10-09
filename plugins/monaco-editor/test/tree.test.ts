import { expect, it } from "vitest";
import { absolutePath, ancestorsOf, buildTree, filterTree } from "../tree.js";

const entries = [
  { path: "src/b.ts", kind: "file" as const },
  { path: "README.md", kind: "file" as const },
  { path: "src/lib/a.ts", kind: "file" as const },
  { path: "docs", kind: "directory" as const },
];

it("builds a sorted tree with directories first", () => {
  const tree = buildTree(entries);
  expect(tree.map((node) => node.path)).toEqual(["docs", "src", "README.md"]);
  expect(tree[1]?.children.map((node) => node.path)).toEqual([
    "src/lib",
    "src/b.ts",
  ]);
});

it("filters by path and expands the folders on the way", () => {
  const { nodes, expand } = filterTree(buildTree(entries), "a.ts");
  expect(nodes.map((node) => node.path)).toEqual(["src"]);
  expect([...expand].sort()).toEqual(["src", "src/lib"]);
  expect(ancestorsOf("src/lib/a.ts")).toEqual(["src", "src/lib"]);
  expect(absolutePath("/repo/", "src/a.ts")).toBe("/repo/src/a.ts");
});
