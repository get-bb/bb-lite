import {
  cliCommand,
  defineCli,
  deny,
  sessions,
  type PluginServerApi,
} from "@bb/plugin";
import { z } from "zod";
import {
  bbAccount,
  type AccountFetchOutput,
  type AccountStatus,
} from "../bb-account/contract.js";
import {
  bbAi,
  formatResetTime,
  usageSchema,
  type BbAiOverview,
  type BbAiUsage,
} from "./contract.js";

const COMPLETE_PATH = "/api/ai/v1/complete";
const USAGE_PATH = "/api/ai/v1/usage";
const COMPLETE_TIMEOUT_MS = 7_000;
const ENABLED_KEY = "enabled";
const OFF = "bb cloud is off. Turn it on with `bb ai on`.";
const SIGN_IN = "Sign in to your bb account";
const NO_CREDENTIAL =
  "bb connect does not share this server's credential with hosted services";
const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;
const ON_TEXT = "bb cloud is on and ready for thread titles.";
const OFF_TEXT =
  "bb cloud is off. bb no longer sends prompts to getbb. Run `bb ai on` to turn it back on.";

const completeSchema = z.object({ text: z.string() });
const gatewayErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    resetsAt: z.number().optional(),
  }),
});

export default async function bbAiServer(bb: PluginServerApi): Promise<void> {
  const { kv } = bb.storage;
  let enabled = (await kv.get<boolean>(ENABLED_KEY)) ?? true;
  let account: AccountStatus | null = null;
  let exhausted: { handle: string | null; until: number } | null = null;
  let remove: (() => void) | null = null;
  let timer: NodeJS.Timeout | undefined;

  const notReady = (current: AccountStatus): string | null => {
    if (!enabled) return OFF;
    if (!current.signedIn) return SIGN_IN;
    if (!current.hosted) return NO_CREDENTIAL;
    const limit = exhausted;
    if (limit?.handle === current.handle && Date.now() < limit.until) {
      return `Daily limit reached; resets ${formatResetTime(limit.until)} UTC`;
    }
    return null;
  };

  const sync = (current: AccountStatus): AccountStatus => {
    account = current;
    const ready = notReady(current) === null;
    if (ready && remove === null) {
      const service = { id: "bb", displayName: "bb cloud", complete };
      remove = bb.add(sessions.inference, service);
    } else if (!ready && remove !== null) {
      remove();
      remove = null;
    }
    return current;
  };
  const refresh = async () => sync(await bb.call(bbAccount.status, {}));

  const failure = (response: AccountFetchOutput, current: AccountStatus) => {
    if (response.status === 401) return SIGN_IN;
    const parsed = gatewayErrorSchema.safeParse(response.body);
    if (!parsed.success) return `bb cloud answered HTTP ${response.status}`;
    const { code, message, resetsAt } = parsed.data.error;
    if (code === "budget_exhausted" && resetsAt !== undefined) {
      exhausted = { handle: current.handle, until: resetsAt };
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), resetsAt - Date.now());
      timer.unref();
      sync(current);
    }
    return message;
  };

  async function complete(prompt: string, { signal }: { signal: AbortSignal }) {
    const current = account ?? (await refresh());
    const reason = notReady(current);
    if (reason !== null) throw new Error(reason);
    const request = {
      method: "POST",
      path: COMPLETE_PATH,
      body: { prompt },
      timeoutMs: COMPLETE_TIMEOUT_MS,
    } as const;
    const response = await bb.call(bbAccount.fetch, request, { signal });
    if (response.status !== 200) throw new Error(failure(response, current));
    const parsed = completeSchema.safeParse(response.body);
    if (!parsed.success) throw new Error("bb cloud returned an invalid reply");
    return parsed.data.text;
  }

  async function usage(current: AccountStatus): Promise<BbAiUsage> {
    const request = { method: "GET", path: USAGE_PATH } as const;
    const response = await bb.call(bbAccount.fetch, request);
    if (response.status !== 200) throw new Error(failure(response, current));
    const parsed = usageSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new Error("bb cloud returned an invalid usage report");
    }
    return parsed.data;
  }

  async function overview(): Promise<BbAiOverview> {
    const current = await refresh();
    const message = notReady(current);
    const known = current.signedIn && current.hosted;
    const report = known
      ? await usage(current).then(
          (value) => ({ usage: value, usageError: null }),
          (err: unknown) => ({ usage: null, usageError: String(err) }),
        )
      : { usage: null, usageError: null };
    const { signedIn, handle } = current;
    const ready = message === null;
    return { enabled, signedIn, handle, ready, message, ...report };
  }

  bb.implement(bbAi.status, overview);
  bb.implement(bbAi.update, async (input) => {
    enabled = input.enabled;
    await kv.set(ENABLED_KEY, enabled);
    return overview();
  });
  bb.implement(bbAi.usage, async () => {
    const current = await refresh();
    if (!current.signedIn) {
      deny("Not signed in to a bb account. Run `bb account login`.");
    }
    return usage(current);
  });
  bb.on(bbAccount.changed, (status) => void sync(status));

  const turn = (on: boolean, summary: string) =>
    cliCommand({
      summary,
      options: { json: JSON_OPTION },
      async run(input) {
        const view = await bb.call(bbAi.update, { enabled: on });
        const text = !on
          ? OFF_TEXT
          : view.ready
            ? ON_TEXT
            : `bb cloud is on but not ready: ${view.message ?? ""}`;
        const stdout = input.options.json ? JSON.stringify(view) : text;
        return { exitCode: 0, stdout: `${stdout}\n` };
      },
    });
  bb.cli.register(
    defineCli({
      name: "ai",
      summary: "Thread titles from bb cloud, included with your bb account",
      commands: {
        on: turn(true, "Turn bb cloud on for thread titles"),
        off: turn(false, "Turn bb cloud off; bb sends nothing to getbb"),
      },
    }),
  );

  bb.onDispose(() => clearTimeout(timer));
  await refresh().catch((err: unknown) => {
    bb.log.warn("Could not read the bb account", { err });
  });
}
