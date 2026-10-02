import { z } from "zod";

export type PaneContent =
  | { kind: "thread"; projectId: string; threadId: string }
  | { kind: "new-thread" }
  | {
      kind: "plugin-panel";
      pluginId: string;
      panelPath: string;
      subPath: string;
    };

export interface PaneNode {
  type: "pane";
  paneId: string;
  content: PaneContent;
}

interface SplitNode {
  type: "split";
  dir: "row" | "col";
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface SplitLayout {
  root: LayoutNode;
  focusedPaneId: string;
}

export type SplitSide = "left" | "right" | "top" | "bottom";
export type SplitPath = readonly number[];

export const MAX_PANES = 8;
export const SPLIT_LAYOUT_STORAGE_KEY = "bb.splitLayout";

const MIN_SIZE = 0.15;
const MAX_SIZE = 0.85;
const SIZE_EPSILON = 1e-12;

export function clampSplitPairFraction(fraction: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, fraction));
}

export function listPanes(root: LayoutNode): PaneNode[] {
  return root.type === "pane" ? [root] : root.children.flatMap(listPanes);
}

export function countPanes(root: LayoutNode): number {
  return listPanes(root).length;
}

export function findPane(root: LayoutNode, paneId: string): PaneNode | null {
  return listPanes(root).find((pane) => pane.paneId === paneId) ?? null;
}

export function isSamePaneContent(
  candidate: PaneContent,
  content: PaneContent,
): boolean {
  if (candidate.kind === "thread" && content.kind === "thread") {
    return (
      candidate.projectId === content.projectId &&
      candidate.threadId === content.threadId
    );
  }
  if (candidate.kind === "plugin-panel" && content.kind === "plugin-panel") {
    return (
      candidate.pluginId === content.pluginId &&
      candidate.panelPath === content.panelPath
    );
  }
  return candidate.kind === "new-thread" && content.kind === "new-thread";
}

export function findPaneByContent(
  root: LayoutNode,
  content: PaneContent,
): PaneNode | null {
  return (
    listPanes(root).find((pane) => isSamePaneContent(pane.content, content)) ??
    null
  );
}

function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function insertPane(
  root: LayoutNode,
  targetPaneId: string,
  side: SplitSide,
  pane: PaneNode,
): LayoutNode {
  const dir = side === "left" || side === "right" ? "row" : "col";
  const paneComesFirst = side === "left" || side === "top";
  if (root.type === "pane") {
    if (root.paneId !== targetPaneId) return root;
    const children = paneComesFirst ? [pane, root] : [root, pane];
    return { type: "split", dir, sizes: [0.5, 0.5], children };
  }
  const targetIndex = root.children.findIndex(
    (child) => child.type === "pane" && child.paneId === targetPaneId,
  );
  if (root.dir === dir && targetIndex !== -1) {
    const children = [...root.children];
    children.splice(paneComesFirst ? targetIndex : targetIndex + 1, 0, pane);
    return { ...root, children, sizes: equalSizes(children.length) };
  }
  const ancestorIndex = root.children.findIndex(
    (child) => findPane(child, targetPaneId) !== null,
  );
  if (ancestorIndex === -1) return root;
  return {
    ...root,
    children: root.children.map((child, index) =>
      index === ancestorIndex
        ? insertPane(child, targetPaneId, side, pane)
        : child,
    ),
  };
}

function withoutPane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "pane") return node.paneId === paneId ? null : node;
  const children = node.children.flatMap(
    (child) => withoutPane(child, paneId) ?? [],
  );
  if (children.length === node.children.length) {
    return children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, children };
  }
  return children.length === 1
    ? (children[0] ?? null)
    : { ...node, children, sizes: equalSizes(children.length) };
}

export function splitPane(
  layout: SplitLayout,
  targetPaneId: string,
  side: SplitSide,
  content: PaneContent,
): SplitLayout {
  const paneIds = new Set(listPanes(layout.root).map((pane) => pane.paneId));
  if (paneIds.size >= MAX_PANES || !paneIds.has(targetPaneId)) return layout;
  let sequence = 1;
  while (paneIds.has(`pane-${sequence}`)) sequence += 1;
  const pane: PaneNode = { type: "pane", paneId: `pane-${sequence}`, content };
  return {
    root: insertPane(layout.root, targetPaneId, side, pane),
    focusedPaneId: pane.paneId,
  };
}

export function replacePaneContent(
  layout: SplitLayout,
  paneId: string,
  content: PaneContent,
): SplitLayout {
  if (findPane(layout.root, paneId) === null) return layout;
  const replace = (node: LayoutNode): LayoutNode =>
    node.type === "split"
      ? { ...node, children: node.children.map(replace) }
      : node.paneId === paneId
        ? { ...node, content }
        : node;
  return { root: replace(layout.root), focusedPaneId: paneId };
}

export function removePane(layout: SplitLayout, paneId: string): SplitLayout {
  const panesBefore = listPanes(layout.root);
  const removedIndex = panesBefore.findIndex((pane) => pane.paneId === paneId);
  const root = withoutPane(layout.root, paneId);
  if (panesBefore.length === 1 || removedIndex === -1 || root === null) {
    return layout;
  }
  const panesAfter = listPanes(root);
  const fallback = panesAfter[Math.min(removedIndex, panesAfter.length - 1)];
  return {
    root,
    focusedPaneId:
      layout.focusedPaneId === paneId && fallback !== undefined
        ? fallback.paneId
        : layout.focusedPaneId,
  };
}

export function movePane(
  layout: SplitLayout,
  paneId: string,
  targetPaneId: string,
  side: SplitSide,
): SplitLayout {
  const pane = findPane(layout.root, paneId);
  const rest = withoutPane(layout.root, paneId);
  if (
    paneId === targetPaneId ||
    pane === null ||
    rest === null ||
    findPane(layout.root, targetPaneId) === null
  ) {
    return layout;
  }
  return {
    root: insertPane(rest, targetPaneId, side, pane),
    focusedPaneId: paneId,
  };
}

function normalizeSizes(
  sizes: readonly number[],
  childCount: number,
): number[] {
  const sum = (values: readonly number[]) =>
    values.reduce((total, size) => total + size, 0);
  const total = sum(sizes);
  if (
    sizes.length !== childCount ||
    sizes.some((size) => !Number.isFinite(size) || size <= 0) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return equalSizes(childCount);
  }
  const normalized = sizes.map((size) => clampSplitPairFraction(size / total));
  for (let pass = 0; pass < childCount + 1; pass += 1) {
    const difference = 1 - sum(normalized);
    if (Math.abs(difference) <= SIZE_EPSILON) break;
    const adjustable = normalized.flatMap((size, index) =>
      (difference > 0 ? size < MAX_SIZE : size > MIN_SIZE) ? [index] : [],
    );
    if (adjustable.length === 0) return equalSizes(childCount);
    for (const index of adjustable) {
      normalized[index] = clampSplitPairFraction(
        (normalized[index] ?? 0) + difference / adjustable.length,
      );
    }
  }
  const remainder = 1 - sum(normalized);
  const correctionIndex = normalized.findIndex(
    (size) => size + remainder >= MIN_SIZE && size + remainder <= MAX_SIZE,
  );
  if (correctionIndex !== -1) {
    normalized[correctionIndex] =
      (normalized[correctionIndex] ?? 0) + remainder;
  }
  return normalized;
}

export function resizeSplit(
  layout: SplitLayout,
  splitPath: SplitPath,
  childIndex: number,
  fraction: number,
): SplitLayout {
  const resize = (node: LayoutNode, depth: number): LayoutNode | null => {
    if (node.type === "pane") return null;
    if (depth < splitPath.length) {
      const index = splitPath[depth] ?? -1;
      const child = node.children[index];
      const resized = child === undefined ? null : resize(child, depth + 1);
      if (resized === null) return null;
      const children = node.children.map((candidate, candidateIndex) =>
        candidateIndex === index ? resized : candidate,
      );
      return { ...node, children };
    }
    const sizes = normalizeSizes(node.sizes, node.children.length);
    const first = sizes[childIndex];
    const second = sizes[childIndex + 1];
    if (
      !Number.isInteger(childIndex) ||
      first === undefined ||
      second === undefined
    ) {
      return null;
    }
    const pairFraction = clampSplitPairFraction(fraction);
    sizes[childIndex] = (first + second) * pairFraction;
    sizes[childIndex + 1] = (first + second) * (1 - pairFraction);
    return { ...node, sizes };
  };
  const root = Number.isFinite(fraction) ? resize(layout.root, 0) : null;
  return root === null ? layout : { ...layout, root };
}

export function setFocus(layout: SplitLayout, paneId: string): SplitLayout {
  return findPane(layout.root, paneId) === null
    ? layout
    : { ...layout, focusedPaneId: paneId };
}

interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function computePaneRects(root: LayoutNode): Map<string, PaneRect> {
  const rects = new Map<string, PaneRect>();
  const collect = (node: LayoutNode, rect: PaneRect): void => {
    if (node.type === "pane") {
      rects.set(node.paneId, rect);
      return;
    }
    const count = node.children.length;
    const total = node.sizes.reduce((sum, size) => sum + size, 0);
    const usableTotal = Number.isFinite(total) && total > 0 ? total : count;
    let offset = 0;
    node.children.forEach((child, index) => {
      const size = node.sizes[index];
      const fraction =
        size !== undefined && size > 0 ? size / usableTotal : 1 / count;
      collect(
        child,
        node.dir === "row"
          ? { ...rect, x: rect.x + rect.w * offset, w: rect.w * fraction }
          : { ...rect, y: rect.y + rect.h * offset, h: rect.h * fraction },
      );
      offset += fraction;
    });
  };
  collect(root, { x: 0, y: 0, w: 1, h: 1 });
  return rects;
}

const id = z.string().min(1);
const paneSchema = z.strictObject({
  type: z.literal("pane"),
  paneId: id,
  content: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("thread"), projectId: id, threadId: id }),
    z.strictObject({ kind: z.literal("new-thread") }),
    z.strictObject({
      kind: z.literal("plugin-panel"),
      pluginId: id,
      panelPath: id,
      subPath: z.string(),
    }),
  ]),
});
const nodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    paneSchema,
    z
      .strictObject({
        type: z.literal("split"),
        dir: z.enum(["row", "col"]),
        sizes: z.array(z.number().positive()),
        children: z.array(nodeSchema).min(2),
      })
      .refine(
        ({ sizes, children }) =>
          sizes.length === children.length &&
          Math.abs(sizes.reduce((sum, size) => sum + size, 0) - 1) <= 1e-9,
      ),
  ]),
);
const storedLayoutSchema = z.strictObject({
  version: z.literal(1),
  layout: z
    .strictObject({ root: nodeSchema, focusedPaneId: id })
    .refine(({ root, focusedPaneId }) => {
      const paneIds = listPanes(root).map((pane) => pane.paneId);
      return (
        paneIds.length <= MAX_PANES &&
        paneIds.includes(focusedPaneId) &&
        new Set(paneIds).size === paneIds.length
      );
    }),
});

export function serializeSplitLayout(layout: SplitLayout): string {
  return JSON.stringify({ version: 1, layout });
}

export function deserializeSplitLayout(
  storedValue: string | null,
): SplitLayout | null {
  try {
    const result = storedLayoutSchema.safeParse(JSON.parse(storedValue ?? ""));
    return result.success ? result.data.layout : null;
  } catch {
    return null;
  }
}
