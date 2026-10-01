import { jsonValueSchema, type ProvisioningTranscriptEntry } from "@bb/domain";
import { z } from "zod";
import type { ThreadRow } from "../db/threads.js";

export const ENVIRONMENT_PROVIDER_IDS = [
  "project-checkout",
  "git-worktree",
  "personal-workspace",
] as const;
export const environmentProviderIdSchema = z.enum(ENVIRONMENT_PROVIDER_IDS);

export const environmentIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reuse"), environmentId: z.string().min(1) }),
  z.object({
    type: z.literal("provider"),
    environmentProviderId: environmentProviderIdSchema,
    hostId: z.string().min(1),
    inputs: jsonValueSchema.nullable(),
  }),
  z.object({ type: z.literal("project-default"), hostId: z.string().min(1) }),
]);
export type EnvironmentIntent = z.infer<typeof environmentIntentSchema>;

export interface EnsureEnvironmentArgs {
  thread: ThreadRow;
  intent: EnvironmentIntent;
  onProgress(entries: ProvisioningTranscriptEntry[]): void;
  signal: AbortSignal;
}

export interface ThreadEnvironment {
  environmentId: string;
  path: string;
}

export interface Environments {
  ensureForThread(args: EnsureEnvironmentArgs): Promise<ThreadEnvironment>;
  pathFor(environmentId: string): string | null;
  workspaceInstructions(environmentId: string): Promise<string | null>;
  onThreadDetached(threadId: string): void;
}
