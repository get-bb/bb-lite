import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const promptScopeSchema = z.enum(["thread", "project", "global"]);
export type PromptScope = z.infer<typeof promptScopeSchema>;

export const composerKindSchema = z.enum(["new-thread", "follow-up"]);
export type ComposerKind = z.infer<typeof composerKindSchema>;

const snippetSchema = z.object({
  text: z.string(),
  highlights: z.array(z.tuple([z.number().int(), z.number().int()])),
});
export type PromptSnippet = z.infer<typeof snippetSchema>;

export const starredPromptSchema = z.object({
  promptId: z.string(),
  text: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type StarredPrompt = z.infer<typeof starredPromptSchema>;

const promptRowSchema = z.discriminatedUnion("kind", [
  starredPromptSchema.extend({
    kind: z.literal("starred"),
    snippet: snippetSchema,
  }),
  z.object({
    kind: z.literal("recent"),
    promptId: z.string(),
    text: z.string(),
    snippet: snippetSchema,
    createdAt: z.number(),
    projectId: z.string(),
    projectName: z.string().nullable(),
    threadId: z.string().nullable(),
    starredId: z.string().nullable(),
  }),
]);
export type PromptRow = z.infer<typeof promptRowSchema>;

export const searchInputSchema = z.object({
  query: z.string().default(""),
  scope: promptScopeSchema.default("global"),
  projectId: z.string().min(1).nullable().default(null),
  threadId: z.string().min(1).nullable().default(null),
  composer: composerKindSchema.default("follow-up"),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

const promptRef = z.object({ promptId: z.string().min(1) });

export const promptLibrary = contract("prompt-library", {
  search: op({
    input: searchInputSchema,
    output: z.object({ prompts: z.array(promptRowSchema) }),
  }),
  list: op({ input: z.object({}), output: z.array(starredPromptSchema) }),
  create: op({
    input: z.object({ text: z.string() }),
    output: starredPromptSchema,
    kind: "write",
  }),
  delete: op({
    input: promptRef,
    output: z.object({ unstarred: z.boolean() }),
    kind: "write",
  }),
  update: op({
    input: promptRef,
    output: z.null(),
    kind: "write",
    audit: false,
  }),
});
