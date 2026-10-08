import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const PromptDecorationExtension = Extension.create({
  name: "promptDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, position) => {
              if (!node.isText || !node.text) return;
              for (const match of node.text.matchAll(/\bultracode\b/giu)) {
                const from = position + match.index;
                decorations.push(
                  Decoration.inline(from, from + match[0].length, {
                    class: "prompt-ultracode-highlight",
                  }),
                );
              }
            });
            return decorations.length > 0
              ? DecorationSet.create(state.doc, decorations)
              : null;
          },
        },
      }),
    ];
  },
});
