import type { Accounts } from "./accounts.js";
import { bbAccounts } from "./bb-accounts.js";
import { relayAccounts } from "./relay-accounts.js";
import { startTunnel } from "./tunnel.js";

function setting(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function accountsFromEnv(secure: boolean): Accounts {
  if (setting("ACCOUNTS", "relay") !== "bb") {
    return relayAccounts({
      relayUrl: setting("RELAY_URL").replace(/\/+$/u, ""),
      relaySecret: setting("RELAY_SECRET"),
    });
  }
  return bbAccounts({
    accountUrl: setting("ACCOUNT_URL"),
    serverBase: setting("SERVER_BASE").toLowerCase(),
    secureCookies: secure,
    ownerCredentialHeader: process.env.OWNER_CREDENTIAL_HEADER || undefined,
    ownerCredentialCookie: process.env.OWNER_CREDENTIAL_COOKIE || undefined,
    entryKey: process.env.ENTRY_KEY || undefined,
  });
}

function hostLabelsFromEnv(): Record<string, string> {
  const pairs = (process.env.HOST_LABELS ?? "").split(",");
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const [host = "", label = ""] = pair.trim().toLowerCase().split("=");
    if (host !== "" && label !== "") labels[host] = label;
  }
  return labels;
}

const log = (message: string) => console.log(message);
const secure = setting("PUBLIC_SCHEME", "https") === "https";
const tunnel = await startTunnel({
  baseHost: setting("BASE_DOMAIN").toLowerCase(),
  secure,
  accounts: accountsFromEnv(secure),
  hostLabels: hostLabelsFromEnv(),
  frps: setting("FRPS", "frps"),
  bindHost: setting("BIND_HOST", "0.0.0.0"),
  ports: {
    web: Number(setting("PORT", "8080")),
    frp: Number(setting("FRP_PORT", "7000")),
    vhost: Number(setting("VHOST_PORT", "8081")),
    hooks: Number(setting("HOOKS_PORT", "8082")),
  },
  logLevel: setting("FRP_LOG_LEVEL", "info"),
  log,
});
tunnel.server.on("exit", (code) => {
  log(`frps exited with code ${code}`);
  process.exit(1);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    tunnel.close();
    process.exit(0);
  });
}
