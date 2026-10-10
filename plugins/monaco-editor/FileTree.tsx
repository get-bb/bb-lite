import { useEffect, useMemo, useState } from "react";
import {
  Icon,
  useBbNavigate,
  useOp,
  type FileViewerProps,
} from "@bb/plugin/app";
import { copyToClipboardWithToast } from "@bb/app-kit/lib/clipboard";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { monacoEditor } from "./contract";
import {
  absolutePath,
  ancestorsOf,
  buildTree,
  filterTree,
  type TreeNode,
} from "./tree";

interface FileTreeProps {
  threadId: string;
  source: FileViewerProps["source"];
  path: string;
  activePath: string;
}

const copy = (text: string, successMessage: string) =>
  void copyToClipboardWithToast(text, { successMessage });

export function FileTree({
  threadId,
  source,
  path,
  activePath,
}: FileTreeProps) {
  const tree = useOp(monacoEditor.tree, { threadId, source, path });
  const navigate = useBbNavigate();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const root = tree.data?.root ?? "";
  const nodes = useMemo(
    () => buildTree(tree.data?.entries ?? []),
    [tree.data?.entries],
  );
  const filtered = useMemo(() => filterTree(nodes, query), [nodes, query]);

  useEffect(() => {
    setExpanded((current) => new Set([...current, ...ancestorsOf(activePath)]));
  }, [activePath]);

  const open = (node: TreeNode) => {
    if (node.kind === "directory") {
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(node.path)) next.add(node.path);
        return next;
      });
      return;
    }
    const target =
      source === "host" ? absolutePath(root, node.path) : node.path;
    navigate.openFile({ threadId, path: target, source });
  };

  const row = (node: TreeNode, depth: number) => {
    const isOpen = expanded.has(node.path) || filtered.expand.has(node.path);
    return (
      <li key={node.path}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => open(node)}
              aria-current={node.path === activePath ? "true" : undefined}
              style={{ paddingLeft: 8 + depth * 12 }}
              className="flex w-full items-center gap-1 truncate py-0.5 pr-2 text-left hover:bg-state-hover aria-[current]:bg-state-active"
            >
              <Icon
                name={
                  node.kind === "file"
                    ? "File"
                    : isOpen
                      ? "ChevronDown"
                      : "ChevronRight"
                }
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{node.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent aria-label={`${node.name} actions`}>
            <ContextMenuItem
              onSelect={() =>
                copy(absolutePath(root, node.path), "Absolute path copied")
              }
            >
              Copy absolute path
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => copy(node.path, "Relative path copied")}
            >
              Copy relative path
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => copy(node.name, "Filename copied")}
            >
              Copy filename
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {node.kind === "directory" && isOpen ? (
          <ul>{node.children.map((child) => row(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex max-h-[40%] min-h-24 shrink-0 flex-col border-b border-border text-sm">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter files"
        aria-label="Filter files"
        className="h-7 shrink-0 border-b border-border bg-transparent px-2 outline-none"
      />
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {tree.status === "error" ? (
          <p className="px-2 text-muted-foreground">Failed to list files.</p>
        ) : tree.data === undefined ? (
          <p className="px-2 text-muted-foreground">Loading files…</p>
        ) : (
          <ul aria-label="Files">
            {filtered.nodes.map((node) => row(node, 0))}
          </ul>
        )}
        {tree.data?.truncated ? (
          <p className="px-2 text-xs text-muted-foreground">
            Showing the first {tree.data.entries.length} entries.
          </p>
        ) : null}
      </div>
    </div>
  );
}
