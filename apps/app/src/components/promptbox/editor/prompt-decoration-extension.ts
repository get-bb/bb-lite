import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  promptEditorSerializationFromDoc,
  type PromptEditorOffsetSegment,
} from "./prompt-editor-serialization";

export const ULTRACODE_HIGHLIGHT_CLASS = "prompt-ultracode-highlight";

interface PromptDecorationRange {
  from: number;
  to: number;
}

interface PromptDecorationPluginState {
  decorations: DecorationSet | null;
  rebuildPending: boolean;
}

const promptDecorationPluginKey = new PluginKey<PromptDecorationPluginState>(
  "promptDecorations",
);

type PromptDecorationMeta = "deferred-rebuild";

export const PROMPT_DECORATION_LARGE_DOC_SIZE = 100_000;
export const PROMPT_DECORATION_LARGE_DOC_REBUILD_DELAY_MS = 200;

function ultracodePattern(): RegExp {
  return /\bultracode\b/giu;
}

export function findUltracodeRanges(text: string): PromptDecorationRange[] {
  const ranges: PromptDecorationRange[] = [];
  const pattern = ultracodePattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

function decorationForIntersection(
  doc: ProseMirrorNode,
  segment: PromptEditorOffsetSegment,
  range: PromptDecorationRange,
): Decoration | null {
  const textFrom = Math.max(segment.textFrom, range.from);
  const textTo = Math.min(segment.textTo, range.to);
  if (textFrom >= textTo) return null;

  if (segment.kind === "mention") {
    const node = doc.nodeAt(segment.docFrom);
    if (node === null) return null;
    return Decoration.node(segment.docFrom, segment.docTo, {
      class: ULTRACODE_HIGHLIGHT_CLASS,
    });
  }

  const docFrom = segment.docFrom + textFrom - segment.textFrom;
  const docTo = segment.docFrom + textTo - segment.textFrom;
  return docFrom < docTo
    ? Decoration.inline(docFrom, docTo, { class: ULTRACODE_HIGHLIGHT_CLASS })
    : null;
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet | null {
  const serialization = promptEditorSerializationFromDoc(doc);
  const decorations: Decoration[] = [];

  for (const range of findUltracodeRanges(serialization.text)) {
    for (const segment of serialization.offsetMapping) {
      const decoration = decorationForIntersection(doc, segment, range);
      if (decoration !== null) decorations.push(decoration);
    }
  }

  return decorations.length === 0
    ? null
    : DecorationSet.create(doc, decorations);
}

function promptDecorationMeta(
  transaction: Transaction,
): PromptDecorationMeta | null {
  const meta: unknown = transaction.getMeta(promptDecorationPluginKey);
  return meta === "deferred-rebuild" ? meta : null;
}

export const PromptDecorationExtension = Extension.create({
  name: "promptDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin<PromptDecorationPluginState>({
        key: promptDecorationPluginKey,
        state: {
          init: (_config, state) => ({
            decorations: buildDecorations(state.doc),
            rebuildPending: false,
          }),
          apply(transaction, previous, _oldState, newState) {
            const meta = promptDecorationMeta(transaction);
            if (meta === null && !transaction.docChanged) return previous;
            if (
              meta === null &&
              newState.doc.content.size > PROMPT_DECORATION_LARGE_DOC_SIZE
            ) {
              return {
                decorations:
                  previous.decorations?.map(
                    transaction.mapping,
                    newState.doc,
                  ) ?? null,
                rebuildPending: true,
              };
            }
            return {
              decorations: buildDecorations(newState.doc),
              rebuildPending: false,
            };
          },
        },
        props: {
          decorations(state) {
            return (
              promptDecorationPluginKey.getState(state)?.decorations ?? null
            );
          },
        },
        view() {
          let rebuildTimeout: ReturnType<typeof setTimeout> | null = null;
          const scheduleDeferredRebuild = (view: EditorView) => {
            if (rebuildTimeout !== null) return;
            rebuildTimeout = setTimeout(() => {
              rebuildTimeout = null;
              if (view.isDestroyed) return;
              view.dispatch(
                view.state.tr.setMeta(
                  promptDecorationPluginKey,
                  "deferred-rebuild" satisfies PromptDecorationMeta,
                ),
              );
            }, PROMPT_DECORATION_LARGE_DOC_REBUILD_DELAY_MS);
          };
          return {
            update(updatedView) {
              if (
                promptDecorationPluginKey.getState(updatedView.state)
                  ?.rebuildPending
              ) {
                scheduleDeferredRebuild(updatedView);
              } else if (rebuildTimeout !== null) {
                clearTimeout(rebuildTimeout);
                rebuildTimeout = null;
              }
            },
            destroy() {
              if (rebuildTimeout !== null) clearTimeout(rebuildTimeout);
            },
          };
        },
      }),
    ];
  },
});
