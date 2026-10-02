import { z } from "zod";

export const threadSearchSourceKindSchema = z.enum([
  "title",
  "title_fallback",
  "user_message",
  "assistant_message",
  "system_message",
]);
export type ThreadSearchSourceKind = z.infer<
  typeof threadSearchSourceKindSchema
>;
