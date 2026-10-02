import { type PromptInput } from "@bb/domain";
import { displayWidth, truncateToWidth } from "@bb/text-utils";
import { fileNameFromPath } from "@bb/thread-view";
import { promptInputToDraft, type PromptDraftState } from "./prompt-draft.js";

const PREVIEW_MAX_WIDTH = 140;
const PREVIEW_ELLIPSIS = "...";

function visibleInput(input: readonly PromptInput[]): PromptInput[] {
  return input.filter((chunk) => chunk.visibility !== "agent-only");
}

function visibleAttachments(input: readonly PromptInput[]) {
  return visibleInput(input).flatMap((chunk) =>
    chunk.type === "localImage" || chunk.type === "localFile" ? [chunk] : [],
  );
}

export function countQueuedMessageAttachments(
  input: readonly PromptInput[],
): number {
  return visibleAttachments(input).length;
}

export function formatQueuedMessagePreview(
  input: readonly PromptInput[],
  options: { truncate?: boolean } = {},
): string {
  const text = visibleInput(input)
    .flatMap((chunk) => (chunk.type === "text" ? [chunk.text.trim()] : []))
    .filter((chunk) => chunk.length > 0)
    .join("\n\n")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length > 0) {
    return options.truncate === false || displayWidth(text) <= PREVIEW_MAX_WIDTH
      ? text
      : `${truncateToWidth(
          text,
          PREVIEW_MAX_WIDTH - PREVIEW_ELLIPSIS.length,
        )}${PREVIEW_ELLIPSIS}`;
  }
  const attachments = visibleAttachments(input);
  const [first] = attachments;
  if (first === undefined) return "(empty message)";
  if (attachments.length > 1) {
    return `Attachment only (${attachments.length} files)`;
  }
  const path = first.path.trim();
  const name =
    (first.type === "localFile" && first.name) ||
    (path.length === 0 ? "Attachment" : fileNameFromPath(path));
  return `Attachment only (${name})`;
}

export function queuedInputToDraft(
  input: readonly PromptInput[],
): PromptDraftState {
  return promptInputToDraft(visibleInput(input));
}
