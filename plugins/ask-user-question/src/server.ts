import { userQuestionPendingInteractionResolutionSchema } from "@bb/domain";
import { interactions, toolError, type PluginServerApi } from "@bb/plugin";
import type { z } from "zod";
import {
  ASK_USER_QUESTION_RENDERER_ID,
  QUESTION_ICON,
  askUserQuestion,
  type InteractionPayload,
  type ToolQuestion,
} from "./contracts.js";

const ADVICE = "Proceed with your best judgement, or ask again in your reply.";

const responseSchema = userQuestionPendingInteractionResolutionSchema.pick({
  answers: true,
});

function toPayload(questions: ToolQuestion[]): InteractionPayload {
  return {
    questions: questions.map((question, index) => ({
      id: `q${index}`,
      prompt: question.question,
      shortLabel: question.header,
      multiSelect: question.multiSelect === true,
      allowFreeText: true,
      options: question.options.map(({ label, description, preview }, at) => {
        const shown = question.multiSelect === true ? "" : preview?.trim();
        const option = { value: `q${index}o${at}`, label, description };
        return shown ? { ...option, preview: shown } : option;
      }),
    })),
  };
}

function toResult(
  questions: ToolQuestion[],
  payload: InteractionPayload,
  response: z.infer<typeof responseSchema>,
) {
  const answers: Record<string, string> = {};
  const annotations: Record<string, { preview?: string; notes?: string }> = {};
  let freeform: string | undefined;
  for (const { id, prompt, options } of payload.questions) {
    const { selected = [], freeText } = response.answers[id] ?? {};
    const chosen = options.filter(({ value }) => selected.includes(value));
    const labels = chosen.map(({ label }) => label).join(", ");
    const answer = [labels, freeText].filter(Boolean).join("; ");
    if (answer === "") continue;
    answers[prompt] = answer;
    const previews = chosen.flatMap((option) => option.preview ?? []);
    const preview = previews.join("\n\n") || undefined;
    const notes = chosen.length > 0 ? freeText : undefined;
    if (chosen.length === 0 && questions.length === 1) freeform = freeText;
    if (preview ?? notes) annotations[prompt] = { preview, notes };
  }
  const annotated = Object.keys(annotations).length > 0;
  const extras = annotated ? { annotations } : {};
  return { questions, answers, response: freeform, ...extras };
}

function describeAnswers(
  payload: InteractionPayload,
  answers: Record<string, string>,
) {
  const lines = payload.questions.map(
    ({ prompt }) => `${prompt} — ${answers[prompt] ?? "no answer"}`,
  );
  const tally = `${Object.keys(answers).length} of ${lines.length} questions`;
  const title = `Answered ${lines.length === 1 ? lines[0] : tally}`;
  const detail = `- ${lines.join("\n- ")}`;
  return { title: title.slice(0, 160), detail: detail.slice(0, 280) };
}

export default function plugin(bb: PluginServerApi): void {
  bb.implement(askUserQuestion.ask, async ({ questions }, context) => {
    const threadId = context.caller.thread;
    if (threadId === null) {
      throw new Error("AskUserQuestion must be called from a thread.");
    }
    const payload = toPayload(questions);
    const [{ header }] = questions;
    const result = await bb.call(interactions.ask, {
      threadId,
      signal: context.signal,
      rendererId: ASK_USER_QUESTION_RENDERER_ID,
      title: questions.length === 1 ? header : `${questions.length} questions`,
      payload,
      timeoutMs: 30 * 60 * 1000,
      presentation: {
        label: { pending: "Asking a question", completed: "Asked" },
        icon: QUESTION_ICON,
      },
      describeSubmission(value) {
        const response = responseSchema.parse(value);
        const { answers } = toResult(questions, payload, response);
        return describeAnswers(payload, answers);
      },
    });
    if (result.outcome === "cancelled") {
      const timedOut = result.reason === "timeout";
      const cause = timedOut ? "did not answer" : "dismissed";
      toolError(`The user ${cause} the question. ${ADVICE}`);
    }
    const response = responseSchema.parse(result.value);
    const answered = toResult(questions, payload, response);
    if (Object.keys(answered.answers).length === 0) {
      toolError(`The user submitted no answers. ${ADVICE}`);
    }
    return JSON.stringify(answered);
  });
}
