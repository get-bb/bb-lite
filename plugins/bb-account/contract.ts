import { contract, event, op, service } from "@bb/plugin";
import { z } from "zod";

const loginSchema = z.object({
  state: z.enum(["pending", "signed-in", "failed"]),
  userCode: z.string(),
  verificationUrl: z.string(),
  message: z.string().nullable(),
});

export const accountStatusSchema = z.object({
  signedIn: z.boolean(),
  handle: z.string().nullable(),
  serverUrl: z.string().nullable(),
  hosted: z.boolean(),
  login: loginSchema.nullable(),
});
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export interface AccountLink {
  baseUrl: string;
  serverUrl: string;
  credential: string;
}
export type CredentialSource = () => AccountLink | null;

export const FETCH_TIMEOUT_MS = { min: 1_000, default: 15_000, max: 65_000 };

const fetchInputSchema = z.object({
  target: z.enum(["api", "gate"]).default("api"),
  method: z.enum(["GET", "POST"]),
  path: z
    .string()
    .regex(/^\/api\/ai\/(?!.*(?:\.\.|\/\/|[?#]))/u)
    .max(2048)
    .describe('Starts with "/api/ai/"; no query, fragment, ".." or "//"'),
  body: z.json().nullable().default(null),
  timeoutMs: z
    .number()
    .int()
    .min(FETCH_TIMEOUT_MS.min)
    .max(FETCH_TIMEOUT_MS.max)
    .default(FETCH_TIMEOUT_MS.default),
});
export type AccountFetchInput = z.input<typeof fetchInputSchema>;

const fetchOutputSchema = z.object({
  status: z.number().int(),
  body: z.json().nullable(),
});
export type AccountFetchOutput = z.infer<typeof fetchOutputSchema>;

export function describeAccount(status: AccountStatus): string {
  const { login } = status;
  if (login?.state === "pending") {
    return [
      "To sign in this bb, open:",
      `  ${login.verificationUrl}`,
      `and confirm the code ${login.userCode}.`,
    ].join("\n");
  }
  const failed = login?.state === "failed" ? `${login.message ?? ""}\n` : "";
  if (!status.signedIn) {
    return `${failed}Not signed in. Run \`bb account login\` to sign in.`;
  }
  return [
    `Signed in as ${status.handle ?? "a getbb account"}`,
    `  Server:  ${status.serverUrl ?? "remote access is off"}`,
  ].join("\n");
}

const print = (status: AccountStatus) => describeAccount(status);
const write = { output: accountStatusSchema, kind: "write" } as const;

export const bbAccount = contract("bb-account", {
  status: op({
    input: z.object({}),
    output: accountStatusSchema,
    doors: {
      cli: { path: "account status", summary: "Show the getbb account", print },
    },
  }),
  login: op({
    input: z.object({
      wait: z
        .boolean()
        .default(false)
        .describe("Wait here until that sign-in finishes"),
    }),
    ...write,
    doors: {
      cli: {
        path: "account login",
        summary: "Sign this bb in to getbb",
        print,
      },
    },
  }),
  logout: op({
    input: z.object({}),
    ...write,
    doors: {
      cli: {
        path: "account logout",
        summary: "Sign this bb out of getbb",
        print,
      },
    },
  }),
  fetch: op({
    input: fetchInputSchema,
    output: fetchOutputSchema,
    internal: true,
  }),
  changed: event(accountStatusSchema),
  credential: service<CredentialSource>(),
});
