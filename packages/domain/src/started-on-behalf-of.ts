import { z } from "zod";

export const startedOnBehalfOfInitiatorValues = ["agent", "system"] as const;
export const startedOnBehalfOfInitiatorSchema = z.enum(
  startedOnBehalfOfInitiatorValues,
);

export const startedOnBehalfOfSchema = z.object({
  initiator: startedOnBehalfOfInitiatorSchema,
  senderThreadId: z.string().min(1),
});
