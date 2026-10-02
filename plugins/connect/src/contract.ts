import { defineRpcContract } from "@bb/plugin";
import { z } from "zod";

const loginViewSchema = z.object({
  state: z.enum(["pending", "signed-in", "failed"]),
  userCode: z.string(),
  verificationUrl: z.string(),
  message: z.string().nullable(),
});
export type LoginView = z.infer<typeof loginViewSchema>;

const statusSchema = z.object({
  state: z.enum(["disconnected", "connected", "reconnecting"]),
  paired: z.boolean(),
  enabled: z.boolean(),
  handle: z.string().nullable(),
  url: z.string().nullable(),
  lastError: z.string().nullable(),
  nextRetryAt: z.number().nullable(),
  login: loginViewSchema.nullable(),
  shares: z.array(z.object({ port: z.number(), url: z.string().nullable() })),
});
export type ConnectStatus = z.infer<typeof statusSchema>;

const portInput = z.object({ port: z.number() }).strict();
const noInput = { input: z.null(), output: statusSchema };

export const connectRpcContract = defineRpcContract({
  status: noInput,
  login: noInput,
  logout: noInput,
  setEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: statusSchema,
  },
  unexpose: { input: portInput, output: statusSchema },
});
