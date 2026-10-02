import { z } from "zod";

export const threadStatusValues = [
  "pending",
  "idle",
  "starting",
  "active",
  "stopping",
  "error",
] as const;
export const threadStatusSchema = z.enum(threadStatusValues);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
