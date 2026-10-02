import { setTimeout as sleep } from "node:timers/promises";
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type CliResult,
  type PluginServerApi,
} from "@bb/plugin";
import {
  providerSchema,
  type Account,
  type AccountSummary,
  type LimitWindow,
  type PoolStatus,
} from "./contract.js";
import type { Pool } from "./server.js";

const json = { type: "boolean", description: "Emit JSON" } as const;
const session = {
  type: "string",
  required: true,
  description: "Session ID printed by `bb pool account add --login`",
} as const;
const LOGIN_POLL_MS = 250;
const ACCOUNT_ID = {
  name: "id",
  description: "Account UUID from `bb pool account list`",
  required: true,
} as const;
const ADD_DESCRIPTION =
  "--login prints the browser or device step and exits; finish it with `bb pool account login-complete` (Claude) or `bb pool account login-poll` (Codex).\n--import reads the provider's existing login on this bb server host (~/.claude or ~/.codex).";

function invalid(message: string): never {
  throw new PluginCliError(message, { code: "invalid_value" });
}

function reply(asJson: boolean, value: object, text: string): CliResult {
  const stdout = asJson ? JSON.stringify(value, null, 2) : text;
  return { exitCode: 0, stdout: `${stdout}\n` };
}

function added(asJson: boolean, account: Account): CliResult {
  const text = `Added ${account.label} (${account.id}).`;
  return reply(asJson, { ok: true, account }, text);
}

function formatWindow({ key, resetAt, utilization }: LimitWindow) {
  const used = utilization === null ? "-" : `${Math.round(utilization * 100)}%`;
  const reset = resetAt === null ? "-" : new Date(resetAt).toISOString();
  return `${key}=${used} ${reset}`;
}

function formatAccounts(accounts: readonly AccountSummary[]): string {
  if (accounts.length === 0) return "No accounts configured.";
  const rows = accounts.map(({ id, label, provider, priority, ...account }) => {
    const limits = account.windows.map(formatWindow).join("; ") || "-";
    const state = account.error ?? account.status;
    return [id, label, provider, priority, limits, state].join("\t");
  });
  return rows.join("\n");
}

function formatStatus(status: PoolStatus): string {
  const { route, routing, config, hosts, accounts } = status;
  const routed = Object.entries(routing).filter(([, enabled]) => enabled);
  const machines = hosts.map((host) => host.hostName ?? host.hostId);
  const head = [
    `Route: ${route}`,
    `Routing: ${routed.map(([name]) => name).join(", ") || "off"}`,
    `Switch threshold: ${config.switchThreshold}`,
    `Machine tokens: ${machines.join(", ") || "none minted"}`,
  ];
  return [...head, "", formatAccounts(accounts)].join("\n");
}

export function registerPoolCli(bb: PluginServerApi, pool: Pool): void {
  const { logins } = pool;
  const accountCommand = (
    summary: string,
    done: string,
    act: (id: string) => Promise<unknown>,
  ) =>
    cliCommand({
      summary,
      positionals: [ACCOUNT_ID],
      options: { json },
      async run({ positionals, options }) {
        const { id } = positionals;
        const account = (await act(id)) ?? null;
        return reply(options.json, { ok: true, id, account }, `${done} ${id}.`);
      },
    });
  const showConfig = async (asJson: boolean) => {
    const { config } = await pool.status();
    const lines = Object.entries(config).map(
      ([key, value]) => `${key}: ${value}`,
    );
    return reply(asJson, { ok: true, config }, lines.join("\n"));
  };

  const commands = {
    status: cliCommand({
      summary: "Show hub, routing, machine token and account status",
      options: { json },
      async run({ options }) {
        const status = await pool.status();
        return reply(options.json, status, formatStatus(status));
      },
    }),
    "account list": cliCommand({
      summary: "List pool accounts and observed quota",
      options: { json },
      async run({ options }) {
        const { accounts } = await pool.status();
        return reply(options.json, { accounts }, formatAccounts(accounts));
      },
    }),
    "account add": cliCommand({
      summary:
        "Sign in to Claude or Codex, import credentials, or add an Anthropic API key",
      description: ADD_DESCRIPTION,
      options: {
        provider: {
          type: "enum",
          values: providerSchema.options,
          required: true,
          description: "Provider this account belongs to",
        },
        login: {
          type: "boolean",
          description: "Start a browser or device login",
        },
        import: { type: "boolean", description: "Import this host's login" },
        "api-key": {
          type: "string",
          description: "Anthropic API key; prefer --api-key-stdin",
        },
        label: { type: "string", description: "Label shown in listings" },
        priority: {
          type: "integer",
          default: 100,
          description: "Failover position; lower numbers run first",
        },
        json,
      },
      async run({ options }) {
        const { provider, label = null, priority } = options;
        const apiKey = options["api-key"] ?? null;
        const sources = [options.login, options.import, apiKey !== null];
        if (sources.filter(Boolean).length !== 1) {
          invalid("Pass exactly one of --login, --import or --api-key.");
        }
        if (!options.login) {
          const input = { provider, apiKey, label, priority };
          return added(options.json, await pool.add(input));
        }
        const login = await logins.start(provider);
        const { sessionId, url, device } = login;
        const finish =
          device === null
            ? [
                "After signing in, pipe the code shown on the final page into:",
                `printf '%s\\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session ${sessionId} --code-stdin`,
              ]
            : [
                `Enter this code: ${device.userCode}`,
                "After authorizing, wait for the account to be added with:",
                `bb pool account login-poll --session ${sessionId}`,
              ];
        const opener = `Open this URL to sign in to ${provider}:`;
        const steps = [opener, url, "", `Session ID: ${sessionId}`, ...finish];
        return reply(options.json, { ok: true, login }, steps.join("\n"));
      },
    }),
    "account login-complete": cliCommand({
      summary: "Complete a Claude browser login with its manual code",
      options: {
        session,
        code: {
          type: "string",
          required: true,
          description: "Code from the final login page; prefer --code-stdin",
        },
        json,
      },
      run: async ({ options }) =>
        added(
          options.json,
          await logins.complete(options.session, options.code),
        ),
    }),
    "account login-poll": cliCommand({
      summary: "Wait for a Codex device-code login to complete",
      options: { session, json },
      async run({ options }, { signal }) {
        for (;;) {
          await sleep(LOGIN_POLL_MS, undefined, { signal });
          const result = await logins.poll(options.session);
          if (result.status === "complete") {
            return added(options.json, result.account);
          }
          if (result.status === "pending") continue;
          throw new PluginCliError(result.message, { code: "login_failed" });
        }
      },
    }),
    "account remove": accountCommand(
      "Remove an account and its secret token file",
      "Removed",
      (id) => pool.remove(id),
    ),
    "account enable": accountCommand(
      "Enable an account and clear its error",
      "Enabled",
      (id) => pool.update(id, { enabled: true }),
    ),
    "account disable": accountCommand("Disable an account", "Disabled", (id) =>
      pool.update(id, { enabled: false }),
    ),
    "account priority": cliCommand({
      summary: "Set an account's position in the failover order",
      positionals: [
        ACCOUNT_ID,
        { name: "priority", description: "Lower runs first", required: true },
      ],
      options: { json },
      async run({ positionals, options }) {
        const priority = Number(positionals.priority);
        if (!Number.isInteger(priority)) invalid("Priority is a whole number.");
        const account = await pool.update(positionals.id, { priority });
        const text = `Set ${account.label} priority to ${priority}.`;
        return reply(options.json, { ok: true, account }, text);
      },
    }),
    routing: cliCommand({
      summary: "Enable or disable pooled routing for one provider",
      positionals: [
        { name: "provider", description: "claude or codex", required: true },
      ],
      options: {
        off: { type: "boolean", description: "Disable instead of enable" },
        json,
      },
      async run({ positionals, options }) {
        const provider = providerSchema.safeParse(positionals.provider).data;
        if (provider === undefined)
          return invalid("Provider is claude or codex.");
        const enabled = !options.off;
        await pool.setRouting(provider, enabled);
        const text = `${enabled ? "Enabled" : "Disabled"} ${provider} routing.`;
        return reply(options.json, { ok: true, provider, enabled }, text);
      },
    }),
    config: cliCommand({
      summary: "Show Account Pooler configuration",
      options: { json },
      run: ({ options }) => showConfig(options.json),
    }),
    "config set": cliCommand({
      summary:
        "Set switchThreshold, the quota fraction at which accounts rotate",
      positionals: [
        { name: "key", description: "switchThreshold", required: true },
        { name: "value", description: "Above 0, at most 1", required: true },
      ],
      options: { json },
      async run({ positionals, options }) {
        const value = Number(positionals.value);
        const valid = value > 0 && value <= 1;
        if (positionals.key !== "switchThreshold" || !valid) {
          invalid(
            "Use: bb pool config set switchThreshold <above 0, at most 1>",
          );
        }
        await pool.setThreshold(value);
        return showConfig(options.json);
      },
    }),
  };
  const summary = "Manage Claude and Codex accounts and the Account Pooler hub";
  bb.cli.register(defineCli({ name: "pool", summary, commands }));
}
