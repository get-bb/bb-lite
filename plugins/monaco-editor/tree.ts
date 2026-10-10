export interface TreeNode {
  path: string;
  name: string;
  kind: "file" | "directory";
  children: TreeNode[];
}

const trim = (path: string) => path.replace(/^\.?\//u, "").replace(/\/+$/u, "");
const parentOf = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

function sortTree(nodes: TreeNode[]): TreeNode[] {
  for (const node of nodes) sortTree(node.children);
  return nodes.sort((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      : left.kind === "directory"
        ? -1
        : 1,
  );
}

export function buildTree(
  entries: readonly { path: string; kind: "file" | "directory" }[],
): TreeNode[] {
  const root: TreeNode = {
    path: "",
    name: "",
    kind: "directory",
    children: [],
  };
  const byPath = new Map([["", root]]);
  const add = (path: string, kind: TreeNode["kind"]): TreeNode => {
    const existing = byPath.get(path);
    if (existing !== undefined) return existing;
    const parent = add(parentOf(path), "directory");
    const name = path.slice(path.lastIndexOf("/") + 1);
    const node: TreeNode = { path, name, kind, children: [] };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };
  for (const entry of entries) {
    const path = trim(entry.path);
    if (path !== "") add(path, entry.kind);
  }
  return sortTree(root.children);
}

export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let at = parentOf(trim(path)); at !== ""; at = parentOf(at)) {
    ancestors.unshift(at);
  }
  return ancestors;
}

export function filterTree(
  nodes: readonly TreeNode[],
  query: string,
): { nodes: TreeNode[]; expand: Set<string> } {
  const needle = query.trim().toLowerCase();
  const expand = new Set<string>();
  if (needle === "") return { nodes: [...nodes], expand };
  const visit = (node: TreeNode): TreeNode[] => {
    if (node.kind === "file") {
      return node.path.toLowerCase().includes(needle) ? [node] : [];
    }
    const children = node.children.flatMap(visit);
    if (children.length === 0) return [];
    expand.add(node.path);
    return [{ ...node, children }];
  };
  return { nodes: nodes.flatMap(visit), expand };
}

export const absolutePath = (root: string, path: string) =>
  root === "" ? path : `${root.replace(/\/+$/u, "")}/${path}`;
