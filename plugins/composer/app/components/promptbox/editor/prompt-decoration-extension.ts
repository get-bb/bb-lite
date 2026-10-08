import { composer, type ComposerTextEffect } from "@bb/plugin/app";
import { slotItems } from "@bb/app-kit/plugins/registry";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface PromptHighlight {
  from: number;
  to: number;
  className: string;
}

export function promptHighlights(
  doc: Node,
  effects: readonly ComposerTextEffect[],
): PromptHighlight[] {
  const highlights: PromptHighlight[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const { text } = node;
    for (const match of text.matchAll(/\bultracode\b/giu)) {
      const from = position + match.index;
      const className = "prompt-ultracode-highlight";
      highlights.push({ from, to: from + match[0].length, className });
    }
    if (effects.length === 0) return;
    const offset = doc.textBetween(0, position, "\n").length;
    for (const { className, match } of effects) {
      for (const { from, to } of match(text, { offset })) {
        if (from < 0 || to <= from || to > text.length) continue;
        highlights.push({
          from: position + from,
          to: position + to,
          className,
        });
      }
    }
  });
  return highlights;
}

export const PromptDecorationExtension = Extension.create({
  name: "promptDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const effects = slotItems(composer.textEffect);
            const highlights = promptHighlights(state.doc, effects);
            if (highlights.length === 0) return null;
            const decorations = highlights.map(({ from, to, className }) =>
              Decoration.inline(from, to, { class: className }),
            );
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
