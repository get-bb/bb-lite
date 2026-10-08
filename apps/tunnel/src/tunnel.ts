import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Accounts } from "./accounts.js";
import { createGate } from "./gate.js";

export interface TunnelOptions {
  baseHost: string;
  secure: boolean;
  accounts: Accounts;
  frps: string;
  bindHost: string;
  ports: { web: number; frp: number; vhost: number; hooks: number };
  logLevel?: string;
  log(message: string): void;
}

export async function startTunnel(options: TunnelOptions) {
  const { baseHost, bindHost, ports, log } = options;
  const gate = createGate({
    baseHost,
    secure: options.secure,
    accounts: options.accounts,
    upstream: { host: "127.0.0.1", port: ports.vhost },
    log,
  });
  const frps = {
    bindAddr: bindHost,
    bindPort: ports.frp,
    proxyBindAddr: "127.0.0.1",
    vhostHTTPPort: ports.vhost,
    vhostHTTPTimeout: 120,
    subdomainHost: baseHost.split(":")[0],
    transport: { maxPoolCount: 10 },
    log: { level: options.logLevel ?? "info", disablePrintColor: true },
    httpPlugins: [
      {
        name: "gate",
        addr: `127.0.0.1:${ports.hooks}`,
        path: "/frp",
        ops: ["Login", "NewProxy", "CloseProxy"],
      },
    ],
  };
  gate.hooks.listen(ports.hooks, "127.0.0.1");
  await once(gate.hooks, "listening");
  const config = join(await mkdtemp(join(tmpdir(), "frps-")), "frps.json");
  await writeFile(config, JSON.stringify(frps));
  const server = spawn(options.frps, ["-c", config], { stdio: "inherit" });
  gate.web.listen(ports.web, bindHost);
  await once(gate.web, "listening");
  log(`gate for *.${baseHost} is listening`);
  const close = () => {
    server.kill("SIGTERM");
    gate.web.close();
    gate.web.closeAllConnections();
    gate.hooks.close();
  };
  return { server, close };
}
