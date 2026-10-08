import { startTunnel } from "./tunnel.js";

function setting(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const log = (message: string) => console.log(message);
const tunnel = await startTunnel({
  baseHost: setting("BASE_DOMAIN").toLowerCase(),
  secure: setting("PUBLIC_SCHEME", "https") === "https",
  relayUrl: setting("RELAY_URL").replace(/\/+$/u, ""),
  relaySecret: setting("RELAY_SECRET"),
  frps: setting("FRPS", "frps"),
  bindHost: "0.0.0.0",
  ports: {
    web: Number(setting("PORT", "8080")),
    frp: Number(setting("FRP_PORT", "7000")),
    vhost: 8081,
    hooks: 8082,
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
