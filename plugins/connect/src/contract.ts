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
  shares: z.array(
    z.object({
      hostId: z.string(),
      port: z.number(),
      url: z.string().nullable(),
    }),
  ),
});
export type ConnectStatus = z.infer<typeof statusSchema>;

export interface AccountLink {
  baseUrl: string;
  serverUrl: string;
  credential: string;
}
export type AccountLinkSource = () => AccountLink | null;

const noInput = z.object({}).strict();
const portInput = z
  .object({ port: z.number(), hostId: z.string().optional() })
  .strict();
const headerPairs = z.array(z.tuple([z.string(), z.string()]));
const bodyChunk = z.object({
  id: z.string(),
  data: z.string(),
  done: z.boolean(),
});
const shareInput = z
  .object({
    port: z.number().int().min(1).max(65_535),
    method: z.string(),
    path: z.string(),
    headers: headerPairs,
    body: z.string().optional(),
  })
  .strict();
const chunkInput = z.object({ id: z.string() }).strict();
const machineOp = { audit: false, internal: true, kind: "write" } as const;
const enabledInput = z.object({ enabled: z.boolean() }).strict();
const write = { output: statusSchema, kind: "write" } as const;

export const connect = contract("connect", {
  status: op({ input: noInput, output: statusSchema }),
  login: op({ input: noInput, ...write }),
  redeem: op({
    input: z.object({ code: z.string().min(1).max(200) }).strict(),
    ...write,
    allow: "owner",
    secret: ["code"],
  }),
  logout: op({ input: noInput, ...write }),
  setEnabled: op({ input: enabledInput, ...write }),
  expose: op({ input: portInput, ...write }),
  unexpose: op({ input: portInput, ...write }),
  shareRequest: op({
    input: shareInput,
    output: bodyChunk.extend({ status: z.number(), headers: headerPairs }),
    ...machineOp,
  }),
  shareChunk: op({ input: chunkInput, output: bodyChunk, ...machineOp }),
  shareClose: op({ input: chunkInput, output: z.object({}), ...machineOp }),
  changed: event(statusSchema),
  link: service<AccountLinkSource>(),
});
