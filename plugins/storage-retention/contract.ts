import { contract, op } from "@bb/plugin";
import { z } from "zod";

const days = z.number().int().min(1).max(3650).nullable();
const count = z.number().int().nonnegative();
const hostId = z.string().min(1);

export const policySchema = z
  .object({
    archiveAfterDays: days,
    deleteAfterDays: days,
    deleteStorageOnArchive: z.boolean().default(false),
    deleteDevDataOnCheckoutRemoval: z.boolean().default(false),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;

export const runSchema = z.object({
  ranAt: z.number(),
  archivedCount: count,
  deletedCount: count,
  failedCount: count,
});
export type Run = z.infer<typeof runSchema>;

export const stateSchema = z.object({
  policy: policySchema,
  lastRun: runSchema.nullable(),
});

const previewSchema = z.object({ archiveCount: count, deleteCount: count });

const entrySchema = z.object({ name: z.string(), sizeBytes: count });
export type Entry = z.infer<typeof entrySchema>;

export const usageSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  scannedAt: z.number(),
  rootPath: z.string(),
  disk: z.object({ totalBytes: count, freeBytes: count }).nullable(),
  threadStorageBytes: count,
  threads: z.array(
    z.object({
      threadId: z.string(),
      sizeBytes: count,
      archived: z.boolean(),
      clearable: z.boolean(),
    }),
  ),
  orphans: z.array(entrySchema),
});
export type Usage = z.infer<typeof usageSchema>;

const machineInput = z.object({ hostId }).strict();

export const storageRetention = contract("storage-retention", {
  state: op({ input: z.object({}), output: stateSchema }),
  preview: op({ input: policySchema, output: previewSchema }),
  configure: op({ input: policySchema, output: stateSchema, kind: "write" }),
  run: op({ input: z.object({}), output: runSchema.nullable(), kind: "write" }),
  usage: op({
    input: z.object({ hostId: hostId.optional() }).strict(),
    output: z.array(usageSchema),
  }),
  scan: op({
    input: z.object({ hostId: hostId.optional() }).strict(),
    output: z.array(usageSchema),
    kind: "write",
    audit: false,
  }),
  removeOrphans: op({
    input: machineInput,
    output: z.object({ removedCount: count, removedBytes: count }),
    kind: "write",
  }),
  retryWorktreeCleanup: op({
    input: machineInput,
    output: z.object({ retriedCount: count }),
    kind: "write",
  }),
  clearThread: op({
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
  }),
  clearArchivedFiles: op({
    input: machineInput,
    output: z.object({ clearedThreads: count, clearedBytes: count }),
    kind: "write",
  }),
  measure: op({
    input: z.object({ rootPath: z.string().min(1) }).strict(),
    output: z.object({
      disk: z.object({ totalBytes: count, freeBytes: count }).nullable(),
      entries: z.array(entrySchema),
    }),
    internal: true,
  }),
  clear: op({
    input: z
      .object({
        rootPath: z.string().min(1),
        names: z.array(z.string().min(1)).min(1).max(500),
        recreate: z.boolean(),
      })
      .strict(),
    output: z.object({ removed: z.array(entrySchema) }),
    kind: "write",
    internal: true,
  }),
});
