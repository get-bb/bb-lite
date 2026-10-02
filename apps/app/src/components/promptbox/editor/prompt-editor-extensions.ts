import Placeholder from "@tiptap/extension-placeholder";
import Blockquote from "@tiptap/extension-blockquote";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo, TrailingNode } from "@tiptap/extensions";
import type { AnyExtension } from "@tiptap/react";
import { PromptDecorationExtension } from "./prompt-decoration-extension";
import { PromptMentionExtension } from "./prompt-mention-extension";

export function promptEditorExtensions(
  getPlaceholder: () => string,
): AnyExtension[] {
  return [
    Blockquote,
    Document,
    HardBreak,
    UndoRedo,
    Paragraph,
    Text,
    TrailingNode,
    Placeholder.configure({ placeholder: getPlaceholder }),
    PromptMentionExtension,
    PromptDecorationExtension,
  ];
}
