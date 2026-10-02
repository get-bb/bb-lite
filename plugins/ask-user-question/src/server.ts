import { userQuestionPendingInteractionResolutionSchema } from "@bb/domain";
import type { AgentToolResult, PluginServerApi } from "@bb/plugin";
import { z } from "zod";
import {
  ASK_USER_QUESTION_RENDERER_ID,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type InteractionPayload,
} from "./contracts.js";

const TOOL_DESCRIPTION = `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. The preview is revealed beneath an option once it is selected. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`;

const TOO_FEW_OPTIONS =
  "This call included a question with fewer than 2 options, so it was rejected and the person never saw it. A question with a single option has no decision in it. Do not retry this call and do not invent a filler second option. Instead, state the one path you were going to offer as the approach you are taking, then continue with the task. If this call also contained questions with 2 to 4 options (each with distinct labels), you may re-ask those questions alone in a new call. Ask a question only when the person has at least two genuinely distinct choices.";
const ADVICE = "Proceed with your best judgement, or ask again in your reply.";

const text = (hint: string) => z.string().trim().min(1).describe(hint);

const toolOptionSchema = z.strictObject({
  label: text(
    "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
  ),
  description: text(
    "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
  ),
  preview: z
    .string()
    .max(4096)
    .optional()
    .describe(
      "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
    ),
});

const toolQuestionSchema = z.strictObject({
  question: text(
    'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  ),
  header: text(
    'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
  ),
  options: z
    .array(toolOptionSchema)
    .min(2, TOO_FEW_OPTIONS)
    .max(MAX_OPTIONS)
    .describe(
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
    ),
  multiSelect: z
    .boolean()
    .optional()
    .describe(
      "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    ),
});
type ToolQuestion = z.infer<typeof toolQuestionSchema>;

const toolInputSchema = z.strictObject({
  questions: z
    .array(toolQuestionSchema)
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("Questions to ask the user (1-4 questions)"),
});
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

function failure(message: string): AgentToolResult {
  return { text: message, isError: true };
}

export default function plugin(bb: PluginServerApi): void {
  const icon = { glyph: "MessageQuestion" };
  bb.agents.registerTool({
    name: "AskUserQuestion",
    description: TOOL_DESCRIPTION,
    presentation: {
      label: { pending: "Asking a question", completed: "Asked a question" },
      icon,
      suppress: true,
    },
    parameters: toolInputSchema,
    enabledFor: ({ providerCapabilities }) =>
      providerCapabilities?.supportsNativeUserQuestion === false,
    async execute({ questions }, { threadId, signal }) {
      const payload = toPayload(questions);
      const [{ header }] = questions;
      const result = await bb.ui.requestInput({
        threadId,
        signal,
        rendererId: ASK_USER_QUESTION_RENDERER_ID,
        title:
          questions.length === 1 ? header : `${questions.length} questions`,
        payload,
        timeoutMs: 30 * 60 * 1000,
        presentation: {
          label: { pending: "Asking a question", completed: "Asked" },
          icon,
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
        return failure(`The user ${cause} the question. ${ADVICE}`);
      }
      const response = responseSchema.parse(result.value);
      const answered = toResult(questions, payload, response);
      return Object.keys(answered.answers).length === 0
        ? failure(`The user submitted no answers. ${ADVICE}`)
        : JSON.stringify(answered);
    },
  });
}
