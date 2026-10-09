import { contract, op } from "@bb/plugin";
import { z } from "zod";

const source = z.enum(["workspace", "thread-storage"]);

export type PreviewSource = z.infer<typeof source>;

const found = { file: z.string(), source, url: z.string() };

export const inlineVis = contract("inline-vis", {
  preview: op({
    input: z.object({
      threadId: z.string().trim().min(1),
      file: z.string(),
      source: z.string().trim().pipe(source).default("workspace"),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("not-found"), file: z.string() }),
      z.object({ kind: z.literal("html"), ...found }),
      z.object({
        kind: z.literal("markdown"),
        ...found,
        content: z.string(),
      }),
    ]),
  }),
});

export type Preview = z.infer<typeof inlineVis.preview.output>;
