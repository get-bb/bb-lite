import {
  promptTextMentionSchema,
  type PromptInput,
  type PromptTextMention,
} from "@bb/domain";
import {
  uploadedPromptAttachmentSchema,
  type UploadedPromptAttachment,
} from "@bb/server-contract";
import { z } from "zod";

export type PromptDraftAttachment = UploadedPromptAttachment;

export interface PromptDraftState {
  text: string;
  mentions: PromptTextMention[];
  attachments: PromptDraftAttachment[];
}

function validItems<T>(schema: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = schema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    );
}

const promptDraftStorageSchema = z.object({
  text: z.string().default(""),
  mentions: validItems(promptTextMentionSchema),
  attachments: validItems(uploadedPromptAttachmentSchema),
});

export function emptyPromptDraftState(): PromptDraftState {
  return { text: "", mentions: [], attachments: [] };
}

function quoteBlock(quotedText: string): string {
  const lines = quotedText.replace(/\r\n|\r/gu, "\n").split("\n");
  return lines
    .filter(
      (line, index) =>
        line.trim().length > 0 ||
        lines[index - 1]?.startsWith(">") !== true ||
        lines[index + 1]?.startsWith(">") !== true,
    )
    .join("\n")
    .trim()
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

export function appendQuoteAndAttachmentsToDraft<
  Draft extends { text: string; attachments: readonly PromptDraftAttachment[] },
>(
  state: Draft,
  quotedText: string,
  attachments: readonly PromptDraftAttachment[],
): Draft {
  const block = quoteBlock(quotedText);
  const quoted =
    block === ">"
      ? state
      : {
          ...state,
          text: `${state.text === "" ? "" : `${state.text}\n`}${block}\n`,
        };
  const paths = new Set(
    quoted.attachments.map((attachment) => attachment.path),
  );
  const added = attachments.filter(
    ({ path }) => !paths.has(path) && paths.add(path),
  );
  return added.length === 0
    ? quoted
    : { ...quoted, attachments: [...quoted.attachments, ...added] };
}

export function isPromptDraftEmpty(draft: PromptDraftState): boolean {
  return (
    draft.text.length === 0 &&
    draft.mentions.length === 0 &&
    draft.attachments.length === 0
  );
}

export function parsePromptDraftStorage(
  rawValue: string | null,
): PromptDraftState {
  try {
    const result = promptDraftStorageSchema.safeParse(
      JSON.parse(rawValue ?? ""),
    );
    return result.success ? result.data : emptyPromptDraftState();
  } catch {
    return emptyPromptDraftState();
  }
}

export function serializePromptDraftStorage(
  draft: PromptDraftState,
): string | null {
  const { text, mentions, attachments } = draft;
  return isPromptDraftEmpty(draft)
    ? null
    : JSON.stringify({
        text,
        ...(mentions.length > 0 ? { mentions } : {}),
        attachments,
      });
}

export function arePromptDraftStatesEqual(
  left: PromptDraftState,
  right: PromptDraftState,
): boolean {
  return (
    serializePromptDraftStorage(left) === serializePromptDraftStorage(right)
  );
}

function isValidMention(mention: PromptTextMention, textLength: number) {
  return (
    mention.start >= 0 &&
    mention.end > mention.start &&
    mention.end <= textLength
  );
}

export function normalizePromptTextMentions(
  mentions: readonly PromptTextMention[],
  textLength: number,
): PromptTextMention[] {
  return mentions
    .filter((mention) => isValidMention(mention, textLength))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

export function promptDraftToInput(draft: PromptDraftState): PromptInput[] {
  const input: PromptInput[] = [];
  const trimStart = draft.text.length - draft.text.trimStart().length;
  const trimEnd = draft.text.trimEnd().length;
  const text = draft.text.slice(trimStart, trimEnd);
  if (text.length > 0) {
    const mentions = normalizePromptTextMentions(
      draft.mentions.flatMap((mention) => {
        const start = Math.max(mention.start, trimStart) - trimStart;
        const end = Math.min(mention.end, trimEnd) - trimStart;
        return start < end ? [{ ...mention, start, end }] : [];
      }),
      text.length,
    );
    input.push({ type: "text", text, mentions });
  }
  for (const { type, path, name, sizeBytes, mimeType } of draft.attachments) {
    input.push(
      type === "localImage"
        ? { type, path }
        : {
            type: "localFile",
            path,
            name,
            ...(sizeBytes > 0 ? { sizeBytes } : {}),
            ...(mimeType ? { mimeType } : {}),
          },
    );
  }
  return input;
}

function fileNameFromPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length === 0
    ? "Attachment"
    : trimmed.split("/").at(-1) || trimmed;
}

export function promptInputToDraft(
  input: readonly PromptInput[],
): PromptDraftState {
  const draft = emptyPromptDraftState();
  for (const chunk of input) {
    if (chunk.type === "text" && chunk.text.trim().length > 0) {
      const offset = draft.text.length === 0 ? 0 : draft.text.length + 2;
      draft.mentions.push(
        ...chunk.mentions
          .filter((mention) => isValidMention(mention, chunk.text.length))
          .map((mention) => ({
            ...mention,
            start: offset + mention.start,
            end: offset + mention.end,
          })),
      );
      draft.text = offset === 0 ? chunk.text : `${draft.text}\n\n${chunk.text}`;
    } else if (chunk.type === "localImage") {
      const name = fileNameFromPath(chunk.path);
      draft.attachments.push({
        type: chunk.type,
        path: chunk.path,
        name,
        sizeBytes: 0,
      });
    } else if (chunk.type === "localFile") {
      draft.attachments.push({
        type: "localFile",
        path: chunk.path,
        name: chunk.name ?? fileNameFromPath(chunk.path),
        sizeBytes: chunk.sizeBytes ?? 0,
        ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
      });
    }
  }
  return draft;
}

export function getProjectStoredPromptAttachmentPaths(
  attachments: readonly PromptDraftAttachment[],
): string[] {
  const isRuntimeReadable = (path: string) =>
    /^[\\/]/u.test(path) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path);
  return [
    ...new Set(
      attachments
        .map((attachment) => attachment.path)
        .filter((path) => !isRuntimeReadable(path)),
    ),
  ];
}
