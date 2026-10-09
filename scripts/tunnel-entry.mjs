#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const USAGE = `Usage: ENTRY_KEY=<key> node scripts/tunnel-entry.mjs --label <label> --gate <url> --port <port>

Sends whoever reaches this port to the frp gate with a one-minute entry link
(docs/tunnel.md). Share the port with the original bb's connect so that only
the server's owner, signed in at its usual address, can reach it.
`;

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const key = process.env.ENTRY_KEY;
const label = option("label");
const gate = option("gate")?.replace(/\/+$/u, "");
const port = Number(option("port"));
if (!key || !label || !gate || !Number.isInteger(port)) {
  console.log(USAGE);
  process.exit(2);
}

createServer((_request, response) => {
  const expiresAt = Date.now() + 60_000;
  const signed = `enter\n${label}\n${expiresAt}`;
  const mac = createHmac("sha256", key).update(signed).digest("hex");
  const location = `${gate}/__gate/enter?token=${expiresAt}.${mac}`;
  response.writeHead(302, { location, "cache-control": "no-store" }).end();
}).listen(port, "127.0.0.1", () => {
  console.log(`entry links for ${label} at ${gate} on port ${port}`);
});
