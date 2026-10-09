import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const MEMORY_KINDS = [
  "fact",
  "preference",
  "decision",
  "procedure",
  "episode",
  "reference",
] as const;

const kind = z.enum(MEMORY_KINDS);
const version = z.number().int().positive();

export const memoryRecord = z.object({
  id: z.string(),
  scope: z.enum(["global", "project"]),
  projectId: z.string().nullable(),
  name: z.string(),
  summary: z.string(),
  details: z.string(),
  kind,
  tags: z.array(z.string()),
  importance: z.number().int().min(0).max(100),
  pinned: z.boolean(),
  sourceThreadId: z.string().nullable(),
  writeReason: z.string(),
  version,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type MemoryRecord = z.infer<typeof memoryRecord>;
export type MemoryKind = z.infer<typeof kind>;

export const memory = contract("memory", {
  list: op({
    input: z.object({}),
    output: z.object({ memories: z.array(memoryRecord) }),
  }),
  update: op({
    input: z.object({
      memoryId: z.string(),
      expectedVersion: version,
      summary: z.string(),
      details: z.string(),
      kind,
      tags: z.array(z.string()),
      importance: z.number().int().min(0).max(100),
      pinned: z.boolean(),
    }),
    output: z.object({ memory: memoryRecord }),
    kind: "write",
  }),
  delete: op({
    input: z.object({ memoryId: z.string(), expectedVersion: version }),
    output: z.object({ deleted: z.object({ id: z.string(), version }) }),
    kind: "write",
  }),
});
