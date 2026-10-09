import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;

const file = z.object({
  threadId: z.string().min(1),
  path: z.string().min(1),
});

export const monacoEditor = contract("monaco-editor", {
  read: op({
    input: file,
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        content: z.string(),
        sha256: z.string(),
      }),
      z.object({ kind: z.literal("unsupported"), reason: z.string() }),
    ]),
  }),
  write: op({
    input: file.extend({
      content: z.string(),
      expectedSha256: z.string().nullable().optional(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict") }),
    ]),
    kind: "write",
  }),
});
