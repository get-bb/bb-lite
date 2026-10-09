import { contract, event, op, service } from "@bb/plugin";
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

export interface AccountLink {
  baseUrl: string;
  serverUrl: string;
  credential: string;
}
export type AccountLinkSource = () => AccountLink | null;

const noInput = z.object({}).strict();
const portInput = z.object({ port: z.number() }).strict();
const enabledInput = z.object({ enabled: z.boolean() }).strict();
const write = { output: statusSchema, kind: "write" } as const;

export const connect = contract("connect", {
  status: op({ input: noInput, output: statusSchema }),
  login: op({ input: noInput, ...write }),
  logout: op({ input: noInput, ...write }),
  setEnabled: op({ input: enabledInput, ...write }),
  unexpose: op({ input: portInput, ...write }),
  changed: event(statusSchema),
  link: service<AccountLinkSource>(),
});
