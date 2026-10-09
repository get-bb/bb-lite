import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  cliCommand,
  defineCli,
  machines,
  PluginCliError,
  server,
  sessions,
  threads,
} from "@bb/plugin";
import type * as Plugin from "@bb/plugin";
import { ConnectAccount, legacyLink, shareUrl, type Link } from "./account.js";
import { connect, type ConnectStatus } from "./contract.js";
import { FrpTunnel } from "./frp.js";
import { watchActivity } from "./activity.js";
import {
  MACHINE_HEADER,
  mintMachine,
  reportActivity,
  revokeMachine,
} from "./hosted.js";
import { ConnectTunnel } from "./tunnel.js";

type Outcome = { text: string; json?: unknown };
type Act = (port: number, context: Plugin.CliContext) => Promise<Outcome>;
type StoredMachine = { machineId: string };

const DEFAULT_BASE_URL = "https://getbb.dev";
const SHARES_KEY = "shares";
const ENABLED_KEY = "enabled";
const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;
const PORT = { name: "port", description: "TCP port on the server machine" };
const LEGACY_WARNING =
  "STOP THE ORIGINAL bb SERVER FIRST. getbb.app allows one tunnel per " +
  "server label: while the original server runs, this one and that one " +
  "keep disconnecting each other and every machine with them.";
const BUSY_STATUSES = ["starting", "active", "stopping"];
const REMOTE_THREAD =
  "This thread runs on another machine. bb connect only shares ports of " +
  "the machine that runs the bb server.";

function describe(status: ConnectStatus): string {
  const { login } = status;
  if (login?.state === "pending") {
    return `Confirm the code ${login.userCode} at ${login.verificationUrl}`;
  }
  if (!status.paired) {
    const failure = login?.state === "failed" ? ` (${login.message})` : "";
    return `Not signed in${failure}. Run \`bb connect login\`.`;
  }
  const state = status.enabled ? status.state : "off";
  const error = status.lastError === null ? "" : `  (${status.lastError})`;
  const shares = status.shares.map(({ port, url }) => `  ${port}  ${url}`);
  const summary = `${status.handle}  ${status.url}  ${state}${error}`;
  return [summary, ...shares].join("\n");
}

function reply(json: boolean, value: unknown, text: string): Plugin.CliResult {
  const stdout = json ? JSON.stringify(value, null, 2) : text;
  return { exitCode: 0, stdout: `${stdout}\n` };
}

export default async function connectPlugin(
  bb: Plugin.PluginServerApi,
): Promise<void> {
  const { kv } = bb.storage;
  let enabled = (await kv.get<boolean>(ENABLED_KEY)) ?? true;
  const shares = new Set((await kv.get<number[]>(SHARES_KEY)) ?? []);
  const hosts = await bb.call(machines.list, {});
  const serverHost = hosts.find((host) => host.machineProviderId === null);
  const remoteThreads = new Set<string>();
  const grants = new Map<string, Promise<Plugin.MachineAccess>>();
  let grantsCredential: string | undefined;
  let publicUrl: string | null = null;
  let removePublicUrl: (() => void) | null = null;

  const publish = (): void => bb.changed(connect.status);
  const account = new ConnectAccount({
    file: join(bb.server.dataDir, "connect.json"),
    provisioned: process.env.BB_CONNECT_LINK,
    baseUrl: process.env.BB_CONNECT_BASE_URL ?? DEFAULT_BASE_URL,
    clientName: hostname().slice(0, 100),
    warn: bb.log.warn,
    onChange: () => sync(),
  });
  const tunnel = new ConnectTunnel({
    loopbackUrl: bb.server.url,
    marker: bb.server.tunnelToken,
    isShared: (port) => shares.has(port),
    confirmRefused: (credential) => account.confirmRefused(credential),
    log: bb.log,
    onChange: publish,
  });
  const frpServer = process.env.BB_CONNECT_FRP;
  const frp =
    frpServer === undefined
      ? null
      : new FrpTunnel({
          server: frpServer,
          binary: process.env.BB_CONNECT_FRPC,
          dir: join(bb.server.dataDir, "frp"),
          loopbackUrl: bb.server.url,
          marker: bb.server.tunnelToken,
          log: bb.log,
        });
  const activeLink = (): Link | null => (enabled ? account.link : null);

  function advertise(url: string | null): void {
    if (url === publicUrl) return;
    removePublicUrl?.();
    publicUrl = url;
    removePublicUrl = url === null ? null : bb.add(server.publicUrl, () => url);
  }

  function sync(): void {
    const link = activeLink();
    if (account.link?.credential !== grantsCredential) grants.clear();
    grantsCredential = account.link?.credential;
    tunnel.set(link);
    frp?.set(link);
    advertise(link?.serverUrl ?? null);
    publish();
  }

  const status = (): ConnectStatus => {
    const { link, login } = account;
    const ports = [...shares].sort((left, right) => left - right);
    const urlOf = (port: number) => link && shareUrl(link, port);
    return {
      ...tunnel.status(),
      paired: link !== null,
      enabled,
      handle: link?.serverLabel ?? null,
      url: link?.serverUrl ?? null,
      login,
      shares: ports.map((port) => ({ port, url: urlOf(port) })),
    };
  };
  const setEnabled = async (next: boolean): Promise<void> => {
    enabled = next;
    await kv.set(ENABLED_KEY, next);
    sync();
  };
  const saveShares = async (): Promise<void> => {
    await kv.set(SHARES_KEY, [...shares]);
    publish();
  };
  const expose = async (port: number, threadId?: string): Promise<string> => {
    const { link } = account;
    const ownPort = Number(new URL(bb.server.url).port);
    const valid = Number.isInteger(port) && port >= 1 && port <= 65_535;
    if (link === null) {
      const message = "this bb isn't signed in; run `bb connect login` first";
      throw new PluginCliError(message, { code: "not_paired" });
    }
    if (!valid || port === ownPort) {
      const message = `Cannot share port ${port}: expected a TCP port other than bb's own`;
      throw new PluginCliError(message, { code: "invalid_port" });
    }
    if (threadId !== undefined && remoteThreads.has(threadId)) {
      throw new PluginCliError(REMOTE_THREAD, { code: "remote_machine" });
    }
    shares.add(port);
    await saveShares();
    return shareUrl(link, port);
  };
  const unexpose = async (ports: number[]): Promise<Outcome> => {
    const removed = ports.filter((port) => shares.delete(port)).length;
    await saveShares();
    return { text: `Revoked ${removed} shared ports.`, json: { removed } };
  };

  const grantMachine = async (link: Link, hostId: string) => {
    const key = `machine:${hostId}`;
    const { baseUrl, credential, serverUrl } = link;
    const machine = await mintMachine(baseUrl, credential);
    await kv.set(key, { machineId: machine.machineId });
    return { serverUrl, headers: { [MACHINE_HEADER]: machine.credential } };
  };
  bb.add(machines.access, {
    async grant(hostId) {
      const link = activeLink();
      if (link === null) return null;
      const granting = grants.get(hostId) ?? grantMachine(link, hostId);
      grants.set(hostId, granting);
      return granting.catch((error: unknown) => {
        grants.delete(hostId);
        throw error;
      });
    },
    async revoke({ id, connectMachineId }) {
      grants.delete(id);
      const key = `machine:${id}`;
      const stored = await kv.get<StoredMachine>(key);
      const { link } = account;
      for (const machineId of new Set([stored?.machineId, connectMachineId])) {
        if (link === null || machineId == null) continue;
        await revokeMachine(link.baseUrl, link.credential, machineId);
      }
      await kv.delete(key);
    },
  });

  const instructions = (threadId: string, hostId: string | null) => {
    const elsewhere = hostId !== null && hostId !== serverHost?.id;
    if (elsewhere) remoteThreads.add(threadId);
    else remoteThreads.delete(threadId);
    const link = activeLink();
    if (link === null || elsewhere) return null;
    return (
      `The user can reach this bb remotely at ${link.serverUrl}. When you ` +
      "start an HTTP server they should see, run `bb connect expose <port>` " +
      "and give them the URL it prints as a markdown link; a localhost URL " +
      "does not open remotely."
    );
  };
  bb.on(sessions.instructions, async ({ threadId, hostId }, next) => {
    const text = instructions(threadId, hostId);
    const rest = await next();
    return text ? [{ source: bb.pluginId, text }, ...rest] : rest;
  });

  bb.implement(connect.status, status);
  bb.implement(connect.login, async () => {
    await account.startLogin();
    return status();
  });
  bb.implement(connect.logout, async () => {
    await account.logout();
    return status();
  });
  bb.implement(connect.setEnabled, async (input) => {
    await setEnabled(input.enabled);
    return status();
  });
  bb.implement(connect.unexpose, async ({ port }) => {
    await unexpose([port]);
    return status();
  });

  const command = (
    summary: string,
    act: Act,
    ...ports: Plugin.CliPositional[]
  ) =>
    cliCommand({
      summary,
      positionals: ports.map((port) => ({ ...port, required: true })),
      options: { json: JSON_OPTION },
      async run(input, context) {
        const port = Number(input.positionals.port);
        const { text, json = status() } = await act(port, context);
        return reply(input.options.json, json, text);
      },
    });
  const told = (current: ConnectStatus): Outcome => {
    return { text: describe(current), json: current };
  };
  const login = async () => told(await bb.call(connect.login, {}));
  const logout = async () => told(await bb.call(connect.logout, {}));
  const show = async () => told(await bb.call(connect.status, {}));
  const turn = (enabled: boolean) => async () =>
    told(await bb.call(connect.setEnabled, { enabled }));
  const revoke = async (ports: number[]): Promise<Outcome> => {
    const held = ports.filter((port) => shares.has(port));
    for (const port of held) await bb.call(connect.unexpose, { port });
    if (held.length === 0) await saveShares();
    const removed = held.length;
    return { text: `Revoked ${removed} shared ports.`, json: { removed } };
  };
  const unshare: Act = (port) => revoke([port]);
  const unshareAll: Act = () => revoke([...shares]);
  const share: Act = async (port, { threadId }) => {
    const url = await expose(port, threadId);
    return { text: url, json: { port, url } };
  };
  const list: Act = async () => {
    const current = await bb.call(connect.status, {});
    return { text: describe(current), json: current.shares };
  };

  bb.cli.register(
    defineCli({
      name: "connect",
      summary: "Reach this bb at its getbb.dev address and share local ports",
      commands: {
        login: command("Sign this bb in to your getbb.dev account", login),
        status: command("Show remote-access status", show),
        logout: command("Sign out and close the tunnel", logout),
        on: command("Turn remote access on", turn(true)),
        off: command("Turn remote access off and stay signed in", turn(false)),
        expose: command("Share a port of the server machine", share, PORT),
        unexpose: command("Stop sharing a port", unshare, PORT),
        "unexpose-all": command("Stop sharing every port", unshareAll),
        shares: command("List shared ports", list),
        "import-legacy": cliCommand({
          summary: "Adopt the bb connect credential of an original bb database",
          description: LEGACY_WARNING,
          options: {
            db: { type: "string", required: true, description: "Old bb.db" },
            yes: { type: "boolean", description: "The original bb is stopped" },
            json: JSON_OPTION,
          },
          async run(input, context) {
            if (!input.options.yes) {
              const hint = "Re-run with --yes once it is stopped.";
              const refusal = { code: "confirmation_required", hint };
              throw new PluginCliError(LEGACY_WARNING, refusal);
            }
            const path = resolve(context.cwd ?? ".", input.options.db);
            account.adopt(legacyLink(path));
            const text = `${LEGACY_WARNING}\n\n${describe(status())}`;
            return reply(input.options.json, status(), text);
          },
        }),
      },
    }),
  );

  if (process.env.BB_CONNECT_LINK !== undefined) {
    const busy = async () => {
      const listed = await bb.call(threads.list, { archived: false });
      return listed.some((thread) => BUSY_STATUSES.includes(thread.status));
    };
    const report = async () => {
      const link = activeLink();
      if (link !== null) await reportActivity(link.baseUrl, link.credential);
    };
    const { warn } = bb.log;
    bb.background.service("activity", {
      start: (signal) => watchActivity({ signal, busy, report, warn }),
    });
  }

  bb.onDispose(() => {
    account.stop();
    tunnel.set(null);
    frp?.set(null);
  });
  sync();
}
