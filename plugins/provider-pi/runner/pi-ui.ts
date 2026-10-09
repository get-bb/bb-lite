import { z } from "zod";
import {
  USER_QUESTION_MAX_OPTIONS,
  userQuestionPendingInteractionPayloadSchema,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
} from "@bb/domain";

const QUESTION = "answer";
const CANCELLED = { cancelled: true };

export const piUiRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string(),
  options: z.array(z.string()).optional(),
  message: z.string().optional(),
  placeholder: z.string().optional(),
  prefill: z.string().optional(),
});
export type PiUiRequest = z.infer<typeof piUiRequestSchema>;

function promptOf(request: PiUiRequest, listed: string[]) {
  const lines = [request.title.trim() || "Pi needs an answer"];
  if (request.message?.trim()) lines.push(request.message.trim());
  if (request.prefill?.trim()) lines.push(`Current value:\n${request.prefill}`);
  if (request.placeholder?.trim()) lines.push(`(${request.placeholder})`);
  if (listed.length > 0) {
    lines.push(listed.map((option, i) => `${i + 1}. ${option}`).join("\n"));
  }
  return lines.join("\n\n");
}

export function piUiPayload(
  request: PiUiRequest,
): PendingInteractionPayload | undefined {
  const all = (request.options ?? []).filter((option) => option.trim());
  const pick =
    request.method === "confirm"
      ? ["Yes", "No"]
      : request.method === "select" && all.length <= USER_QUESTION_MAX_OPTIONS
        ? all
        : [];
  const listed = request.method === "select" && pick.length === 0 ? all : [];
  const question = {
    id: QUESTION,
    prompt: promptOf(request, listed),
    multiSelect: false,
    options: pick.map((option) => ({ value: option, label: option })),
    allowFreeText: pick.length === 0,
  };
  const payload = { kind: "user_question" as const, questions: [question] };
  const parsed = userQuestionPendingInteractionPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

export function piUiResponse(
  request: PiUiRequest,
  resolution: PendingInteractionResolution,
): Record<string, unknown> {
  if (!("kind" in resolution) || resolution.kind !== "user_answer") {
    return CANCELLED;
  }
  const answer = resolution.answers[QUESTION];
  const value = answer?.selected[0] ?? answer?.freeText;
  if (value === undefined) return CANCELLED;
  if (request.method === "confirm") return { confirmed: value === "Yes" };
  if (request.method !== "select") return { value };
  const options = request.options ?? [];
  const index = /^\d+$/.test(value.trim()) ? Number(value.trim()) - 1 : -1;
  const chosen = options.includes(value) ? value : options[index];
  return chosen === undefined ? CANCELLED : { value: chosen };
}
