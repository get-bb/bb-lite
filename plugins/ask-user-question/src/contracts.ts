import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const ASK_USER_QUESTION_RENDERER_ID = "ask-user-question";
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;

const interactionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
});

const interactionQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  shortLabel: z.string().min(1),
  multiSelect: z.boolean(),
  options: z.array(interactionOptionSchema).max(MAX_OPTIONS),
  allowFreeText: z.boolean(),
});

export const interactionPayloadSchema = z.object({
  questions: z.array(interactionQuestionSchema).min(1).max(MAX_QUESTIONS),
});
export type InteractionPayload = z.infer<typeof interactionPayloadSchema>;

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
export type ToolQuestion = z.infer<typeof toolQuestionSchema>;

const toolInputSchema = z.strictObject({
  questions: z
    .array(toolQuestionSchema)
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("Questions to ask the user (1-4 questions)"),
});

const capabilitiesSchema = z.object({
  supportsNativeUserQuestion: z.boolean(),
});

function hasNativeQuestions(capabilities: unknown): boolean | undefined {
  return capabilitiesSchema.safeParse(capabilities).data
    ?.supportsNativeUserQuestion;
}

export const QUESTION_ICON = { glyph: "MessageQuestion" };

export const askUserQuestion = contract("ask-user-question", {
  ask: op({
    input: toolInputSchema,
    output: z.string(),
    kind: "write",
    doors: {
      agent: {
        name: "AskUserQuestion",
        description: TOOL_DESCRIPTION,
        presentation: {
          label: {
            pending: "Asking a question",
            completed: "Asked a question",
          },
          icon: QUESTION_ICON,
          suppress: true,
        },
        enabledFor: ({ providerCapabilities }) =>
          hasNativeQuestions(providerCapabilities) === false,
      },
    },
  }),
});
