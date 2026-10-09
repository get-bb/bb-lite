import { deny, type PluginServerApi } from "@bb/plugin";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "bb-plugin-connect/contract.js";
import {
  bbAccount,
  type AccountFetchOutput,
  type AccountStatus,
} from "./contract.js";

export interface BbAccountOptions {
  fetch: typeof globalThis.fetch;
  refreshMs: number;
  waitMs: number;
}

const DEFAULTS: BbAccountOptions = {
  fetch: (input, init) => globalThis.fetch(input, init),
  refreshMs: 15_000,
  waitMs: 1_000,
};
const SIGNED_OUT: AccountFetchOutput = {
  status: 401,
  body: {
    error: { code: "signed_out", message: "Sign in to your bb account" },
  },
};

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

export function createBbAccount(options: BbAccountOptions) {
  return function bbAccountServer(bb: PluginServerApi): void {
    let last = "";

    const status = async (): Promise<AccountStatus> => {
      const current = await bb.call(connect.status, {});
      const source = bb.pick(connect.link);
      return {
        signedIn: current.paired,
        handle: current.handle,
        serverUrl: current.url,
        hosted: current.paired && source?.() != null,
        login: current.login,
      };
    };

    const refresh = async (): Promise<AccountStatus> => {
      const current = await status();
      const seen = JSON.stringify(current);
      if (seen !== last) {
        last = seen;
        bb.changed(bbAccount.status);
        bb.emit(bbAccount.changed, current);
      }
      return current;
    };

    const settle = async (signal?: AbortSignal): Promise<AccountStatus> => {
      for (;;) {
        const current = await refresh();
        if (current.login?.state !== "pending") return current;
        await sleep(options.waitMs, undefined, { signal });
      }
    };

    bb.implement(bbAccount.status, refresh);
    bb.implement(bbAccount.login, async ({ wait }, { signal }) => {
      await bb.call(connect.login, {});
      if (!wait) return refresh();
      const current = await settle(signal);
      if (current.signedIn) return current;
      return deny(current.login?.message ?? "The sign-in did not finish");
    });
    bb.implement(bbAccount.logout, async () => {
      await bb.call(connect.logout, {});
      return refresh();
    });

    bb.implement(bbAccount.fetch, async (input, { signal }) => {
      const link = bb.pick(connect.link)?.() ?? null;
      if (link === null) return SIGNED_OUT;
      const origin = input.target === "gate" ? link.serverUrl : link.baseUrl;
      const timeout = AbortSignal.timeout(input.timeoutMs);
      const response = await options.fetch(`${origin}${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${link.credential}`,
          ...(input.body === null
            ? {}
            : { "content-type": "application/json" }),
        },
        body: input.body === null ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.any([signal, timeout]),
      });
      return { status: response.status, body: await readJson(response) };
    });

    bb.on(connect.changed, () => {
      void refresh().catch(() => {});
    });

    bb.background.service("refresh", {
      async start(signal) {
        while (!signal.aborted) {
          await refresh().catch((err: unknown) => {
            bb.log.warn("Could not read the account from bb connect", { err });
          });
          await sleep(options.refreshMs, undefined, { signal }).catch(() => {});
        }
      },
    });
  };
}

export default createBbAccount(DEFAULTS);
