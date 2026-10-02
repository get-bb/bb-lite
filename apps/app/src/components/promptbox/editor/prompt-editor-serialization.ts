import { z } from "zod";
import {
  promptMentionResourceSchema,
  type PromptMentionCommandTrigger,
  type PromptMentionResource,
  type PromptTextMention,
} from "@bb/domain";
import type { JSONContent } from "@tiptap/react";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";
import type {
  PromptMentionSuggestion,
  ProviderCommandSuggestion,
} from "@bb/client-core";

export interface PromptEditorValue {
  text: string;
  mentions: PromptTextMention[];
}

interface PromptEditorContentValue {
  text: string;
  mentions: readonly PromptTextMention[];
}

const promptEditorMentionAttrsSchema = z.object({
  resource: promptMentionResourceSchema,
  serializedText: z.string().min(1),
});

export function parsePromptEditorMentionAttrs(
  attrs: ProseMirrorNode["attrs"],
): z.infer<typeof promptEditorMentionAttrsSchema> | null {
  const result = promptEditorMentionAttrsSchema.safeParse(attrs);
  return result.success ? result.data : null;
}

function textContent(text: string): JSONContent[] {
  return text
    .split("\n")
    .flatMap((part, index) => [
      ...(index > 0 ? [{ type: "hardBreak" }] : []),
      ...(part.length > 0 ? [{ type: "text", text: part }] : []),
    ]);
}

export function promptEditorInlineContentFromValue(
  value: PromptEditorContentValue,
): JSONContent[] {
  const content: JSONContent[] = [];
  let cursor = 0;
  const mentions = value.mentions
    .filter(
      (mention) =>
        mention.start >= 0 &&
        mention.end > mention.start &&
        mention.end <= value.text.length,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const mention of mentions) {
    if (mention.start < cursor) continue;
    content.push(...textContent(value.text.slice(cursor, mention.start)));
    content.push({
      type: "mention",
      attrs: {
        resource: mention.resource,
        serializedText: value.text.slice(mention.start, mention.end),
      },
    });
    cursor = mention.end;
  }
  content.push(...textContent(value.text.slice(cursor)));
  return content;
}

interface SourceLine {
  start: number;
  text: string;
}

function isQuoteLine(line: string): boolean {
  return line === ">" || line.startsWith("> ");
}

function paragraphFromLines(
  value: PromptEditorContentValue,
  lines: readonly SourceLine[],
  prefixLength: (line: string) => number,
): JSONContent {
  let text = "";
  const mentions: PromptTextMention[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) text += "\n";
    const from = line.start + prefixLength(line.text);
    const to = line.start + line.text.length;
    for (const mention of value.mentions) {
      if (mention.start >= from && mention.end <= to) {
        mentions.push({
          ...mention,
          start: mention.start - from + text.length,
          end: mention.end - from + text.length,
        });
      }
    }
    text += value.text.slice(from, to);
  }
  return {
    type: "paragraph",
    content: promptEditorInlineContentFromValue({ text, mentions }),
  };
}

export function promptEditorContentFromValue(
  value: PromptEditorContentValue,
): JSONContent {
  const blocks: JSONContent[] = [];
  const lines: SourceLine[] = [];
  let offset = 0;
  for (const text of value.text.split("\n")) {
    lines.push({ start: offset, text });
    offset += text.length + 1;
  }
  let index = 0;
  while (value.text.length > 0 && index < lines.length) {
    const quote = isQuoteLine(lines[index]!.text);
    let end = index;
    while (end < lines.length && isQuoteLine(lines[end]!.text) === quote) {
      end += 1;
    }
    const group = lines.slice(index, end);
    if (quote) {
      blocks.push({
        type: "blockquote",
        content: [
          paragraphFromLines(value, group, (line) =>
            line.startsWith("> ") ? 2 : 1,
          ),
        ],
      });
      if (
        lines[end]?.text === "" &&
        end + 1 < lines.length &&
        !isQuoteLine(lines[end + 1]!.text)
      ) {
        end += 1;
      }
    } else {
      blocks.push(paragraphFromLines(value, group, () => 0));
    }
    index = end;
  }
  return {
    type: "doc",
    content: blocks.length > 0 ? blocks : [{ type: "paragraph", content: [] }],
  };
}

function serializePromptEditorNode(node: ProseMirrorNode): PromptEditorValue {
  let text = "";
  let previousBlockWasQuote: boolean | null = null;
  const mentions: PromptTextMention[] = [];
  const appendInline = (child: ProseMirrorNode) => {
    if (child.isText) {
      text += child.text ?? "";
    } else if (child.type.name === "hardBreak") {
      text += "\n";
    } else if (child.type.name === "mention") {
      const attrs = parsePromptEditorMentionAttrs(child.attrs);
      if (!attrs) return;
      mentions.push({
        start: text.length,
        end: text.length + attrs.serializedText.length,
        resource: attrs.resource,
      });
      text += attrs.serializedText;
    } else {
      child.forEach(appendInline);
    }
  };
  node.forEach((block) => {
    if (!block.isBlock) {
      appendInline(block);
      return;
    }
    const quote = block.type.name === "blockquote";
    if (previousBlockWasQuote !== null) {
      text += previousBlockWasQuote && !quote ? "\n\n" : "\n";
    }
    previousBlockWasQuote = quote;
    if (!quote) {
      block.forEach(appendInline);
      return;
    }
    const inner = serializePromptEditorNode(block);
    const lines = inner.text.split("\n");
    const blockStart = text.length;
    const prefixBefore = (innerOffset: number): number => {
      const lineIndex = inner.text.slice(0, innerOffset).split("\n").length - 1;
      return lines
        .slice(0, lineIndex + 1)
        .reduce((sum, line) => sum + (line.length > 0 ? 2 : 1), 0);
    };
    text += lines
      .map((line) => (line.length > 0 ? `> ${line}` : ">"))
      .join("\n");
    for (const mention of inner.mentions) {
      mentions.push({
        ...mention,
        start: blockStart + mention.start + prefixBefore(mention.start),
        end: blockStart + mention.end + prefixBefore(mention.start),
      });
    }
  });
  return { text, mentions };
}

export function promptEditorValueFromDoc(
  doc: ProseMirrorNode,
): PromptEditorValue {
  return serializePromptEditorNode(doc);
}

export function promptEditorValueFromSlice(
  slice: Slice,
  schema: Schema,
): PromptEditorValue {
  const doc = schema.topNodeType.createAndFill(null, slice.content);
  return doc
    ? serializePromptEditorNode(doc)
    : {
        text: slice.content.textBetween(0, slice.content.size, "\n"),
        mentions: [],
      };
}

export function promptEditorCopiedSlice(
  slice: Slice,
  selection: Selection,
): Slice {
  const { $from, $to } = selection;
  const startsLine =
    $from.parentOffset === 0 || $from.nodeBefore?.type.name === "hardBreak";
  const endsLine =
    $to.parentOffset === $to.parent.content.size ||
    $to.nodeAfter?.type.name === "hardBreak";
  if (startsLine && endsLine) return slice;

  const schema = $from.doc.type.schema;
  let { content, openStart, openEnd } = slice;
  let result = slice;
  while (openStart > 0 && openEnd > 0 && content.childCount === 1) {
    const ancestor = content.firstChild!;
    if (ancestor.isTextblock) {
      return new Slice(
        Fragment.from(schema.nodes.paragraph!.create(null, ancestor.content)),
        1,
        1,
      );
    }
    content = ancestor.content;
    openStart -= 1;
    openEnd -= 1;
    if (schema.topNodeType.validContent(content)) {
      result = new Slice(content, openStart, openEnd);
    }
  }
  return result;
}

export function promptMentionResourceFromSuggestion(
  suggestion: PromptMentionSuggestion,
): PromptMentionResource {
  switch (suggestion.kind) {
    case "thread":
      return {
        kind: "thread",
        threadId: suggestion.threadId,
        projectId: suggestion.projectId,
        label: suggestion.title?.trim() || suggestion.threadId,
      };
    case "project":
      return {
        kind: "project",
        projectId: suggestion.projectId,
        label: suggestion.name.trim() || suggestion.projectId,
      };
    case "section":
      return {
        kind: "section",
        sectionId: suggestion.sectionId,
        label: suggestion.name.trim() || suggestion.sectionId,
      };
    case "plugin":
      return {
        kind: "plugin",
        pluginId: suggestion.pluginId,
        icon: suggestion.icon,
        itemId: suggestion.itemId,
        label: suggestion.title.trim() || suggestion.itemId,
      };
    case "path":
      return {
        kind: "path",
        source: suggestion.source,
        entryKind: suggestion.entryKind,
        path: suggestion.path,
        label: suggestion.name,
      };
  }
}

export function promptCommandResourceFromSuggestion(
  suggestion: ProviderCommandSuggestion,
  trigger: PromptMentionCommandTrigger,
): PromptMentionResource {
  return {
    kind: "command",
    trigger,
    name: suggestion.name,
    source: suggestion.source,
    origin: suggestion.origin,
    label: suggestion.name,
    argumentHint: suggestion.argumentHint,
  };
}
