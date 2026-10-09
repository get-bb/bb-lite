import type { Server } from "node:http";
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
import { z } from "zod";
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
import { listenRemote, type RemoteShare } from "./remote.js";
import { ConnectTunnel } from "./tunnel.js";

type Outcome = { text: string; json?: unknown };
type Act = (
  port: number,
  context: Plugin.CliContext,
  host: string | undefined,
) => Promise<Outcome>;
type StoredMachine = { machineId: string };

const DEFAULT_BASE_URL = "https://getbb.dev";
const SHARES_KEY = "shares";
const ENABLED_KEY = "enabled";
const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;
const PORT = {
  name: "port",
  description: "TCP port on the machine the command runs on",
};
const HOST_OPTION = {
  type: "string",
  description: "Machine id whose port to share (default: this machine)",
} as const;
const storedShare = z.union([
  z.number(),
  z.object({ hostId: z.string(), port: z.number() }),
]);
const LEGACY_WARNING =
  "STOP THE ORIGINAL bb SERVER FIRST. getbb.app allows one tunnel per " +
  "server label: while the original server runs, this one and that one " +
  "keep disconnecting each other and every machine with them.";
const BUSY_STATUSES = ["starting", "active", "stopping"];

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
  const localHost = bb.server.hostId;
  const saved = z
    .array(storedShare)
    .catch([])
    .parse(await kv.get(SHARES_KEY));
  const shares = new Map<number, RemoteShare>();
  for (const entry of saved) {
    const share =
      typeof entry === "number" ? { hostId: localHost, port: entry } : entry;
    shares.set(share.port, share);
  }
  const relays = new Map<number, Promise<{ server: Server; origin: string }>>();
  const origins = new Map<number, string>();
  const grants = new Map<string, Promise<Plugin.MachineAccess>>();
  let grantsCredential: string | undefined;
  let publicUrl: string | null = null;
  let removePublicUrl: (() => void) | null = null;

  const publish = (): void => {
    bb.changed(connect.status);
    bb.emit(connect.changed, status());
  };
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
    originOf: (port) => {
      const share = shares.get(port);
      if (share === undefined) return null;
      if (share.hostId === localHost) return `http://127.0.0.1:${port}`;
      return origins.get(port) ?? null;
    },
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
  bb.add(connect.link, () => {
    const { link } = account;
    if (link === null) return null;
    const { baseUrl, serverUrl, credential } = link;
    return { baseUrl, serverUrl, credential };
  });

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
    const listed = [...shares.values()];
    listed.sort((left, right) => left.port - right.port);
    const urlOf = (port: number) => link && shareUrl(link, port);
    return {
      ...tunnel.status(),
      paired: link !== null,
      enabled,
      handle: link?.serverLabel ?? null,
      url: link?.serverUrl ?? null,
      login,
      shares: listed.map((share) => ({ ...share, url: urlOf(share.port) })),
    };
  };
  const setEnabled = async (next: boolean): Promise<void> => {
    enabled = next;
    await kv.set(ENABLED_KEY, next);
    sync();
  };
  const relay = async (share: RemoteShare): Promise<void> => {
    if (share.hostId === localHost || relays.has(share.port)) return;
    const started = listenRemote(bb.runners, share);
    relays.set(share.port, started);
    try {
      origins.set(share.port, (await started).origin);
    } catch (error) {
      relays.delete(share.port);
      bb.log.warn(`share relay failed: ${String(error)}`);
    }
  };
  const unrelay = (port: number): void => {
    const started = relays.get(port);
    relays.delete(port);
    origins.delete(port);
    void started?.then(({ server }) => {
      server.close();
      server.closeAllConnections();
    });
  };
  for (const share of shares.values()) void relay(share);
  const saveShares = async (): Promise<void> => {
    await kv.set(SHARES_KEY, [...shares.values()]);
    publish();
  };
  const expose = async (port: number, hostId = localHost): Promise<string> => {
    const { link } = account;
    const ownPort = Number(new URL(bb.server.url).port);
    const valid = Number.isInteger(port) && port >= 1 && port <= 65_535;
    const local = hostId === localHost;
    if (link === null) {
      const message = "this bb isn't signed in; run `bb connect login` first";
      throw new PluginCliError(message, { code: "not_paired" });
    }
    if (!valid || (local && port === ownPort)) {
      const message = `Cannot share port ${port}: expected a TCP port other than bb's own`;
      throw new PluginCliError(message, { code: "invalid_port" });
    }
    const hosts = local ? [] : await bb.call(machines.list, {});
    if (!local && !hosts.some((host) => host.id === hostId)) {
      const message = `Cannot share port ${port}: no machine ${hostId}`;
      throw new PluginCliError(message, { code: "unknown_host" });
    }
    const held = shares.get(port);
    if (held !== undefined && held.hostId !== hostId) {
      const message =
        `Port ${port} is already shared from machine ${held.hostId}; ` +
        "a share URL names only the port, so run `bb connect unexpose " +
        `${port}\` first`;
      throw new PluginCliError(message, { code: "port_taken" });
    }
    const share = { hostId, port };
    shares.set(port, share);
    await relay(share);
    await saveShares();
    return shareUrl(link, port);
  };
  const held = (port: number, hostId?: string): boolean => {
    const share = shares.get(port);
    return share !== undefined && (hostId ?? share.hostId) === share.hostId;
  };
  const unexpose = async (port: number, hostId?: string): Promise<void> => {
    if (!held(port, hostId)) return;
    shares.delete(port);
    unrelay(port);
    await saveShares();
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

  const instructions = () => {
    const link = activeLink();
    if (link === null) return null;
    return (
      `The user can reach this bb remotely at ${link.serverUrl}. When you ` +
      "start an HTTP server they should see, run `bb connect expose <port>` " +
      "and give them the URL it prints as a markdown link; a localhost URL " +
      "does not open remotely."
    );
  };
  bb.on(sessions.instructions, async (_input, next) => {
    const text = instructions();
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
  bb.implement(connect.expose, async ({ port, hostId }) => {
    await expose(port, hostId);
    return status();
  });
  bb.implement(connect.unexpose, async ({ port, hostId }) => {
    await unexpose(port, hostId);
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
      options: {
        json: JSON_OPTION,
        ...(ports.length > 0 ? { host: HOST_OPTION } : {}),
      },
      async run(input, context) {
        const port = Number(input.positionals.port);
        const { host } = input.options;
        const { text, json = status() } = await act(port, context, host);
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
  const revoke = async (ports: number[], hostId?: string) => {
    const owned = ports.filter((port) => held(port, hostId));
    for (const port of owned) {
      await bb.call(connect.unexpose, { port, hostId });
    }
    if (owned.length === 0) await saveShares();
    const removed = owned.length;
    return { text: `Revoked ${removed} shared ports.`, json: { removed } };
  };
  const unshare: Act = (port, _context, host) => revoke([port], host);
  const unshareAll: Act = () => revoke([...shares.keys()]);
  const share: Act = async (port, context, host) => {
    const hostId = host ?? context.hostId ?? localHost;
    const url = await expose(port, hostId);
    return { text: url, json: { hostId, port, url } };
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
        expose: command("Share a port of this machine", share, PORT),
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
    for (const port of [...relays.keys()]) unrelay(port);
  });
  sync();
}
