#!/usr/bin/env node
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { join } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: node scripts/tunnel-compare.mjs --data <bb data dir> [options]

Times the same requests to one bb server through the relay (Workers) and
through frp on Fly (docs/tunnel.md), using a machine credential it mints for
the run and revokes afterwards.

  --data <dir>       Data directory of the linked server (holds connect.json)
  --frp-base <host>  Base host of the frp gate (default: fly.<relay host>)
  --frp-via <host>   Connect to this host instead of <label>.<frp base>,
                     for use before the DNS records exist
  --runs <n>         Requests per sequential case (default: 40)
`;

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "frp-base": { type: "string" },
    "frp-via": { type: "string" },
    runs: { type: "string", default: "40" },
    help: { type: "boolean" },
  },
});
if (values.help || values.data === undefined) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const link = JSON.parse(
  readFileSync(join(values.data, "connect.json"), "utf8"),
);
const relayHost = new URL(link.baseUrl).host;
const frpBase = values["frp-base"] ?? `fly.${relayHost}`;
const runs = Number(values.runs);
const routes = [
  { name: "relay (Workers)", authority: `${link.serverLabel}.${relayHost}` },
  {
    name: "frp (Fly)",
    authority: `${link.serverLabel}.${frpBase}`,
    via: values["frp-via"],
  },
];

async function relayCall(path, body, credential) {
  const headers = { "content-type": "application/json" };
  if (credential !== undefined) headers.authorization = `Bearer ${credential}`;
  const sent = { method: "POST", headers, body: JSON.stringify(body ?? {}) };
  const response = await fetch(`${link.baseUrl}${path}`, sent);
  if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
  return response.json();
}

function connect(route) {
  const session = http2.connect(`https://${route.via ?? route.authority}`);
  return new Promise((resolve, reject) => {
    session.once("connect", () => resolve(session));
    session.once("error", reject);
  });
}

function get(session, route, path, machine) {
  const started = performance.now();
  const stream = session.request({
    ":method": "GET",
    ":path": path,
    ":authority": route.authority,
    "accept-encoding": "gzip",
    "x-bb-connect-machine": machine,
  });
  return new Promise((resolve, reject) => {
    let status = 0;
    let bytes = 0;
    stream.on("response", (headers) => (status = headers[":status"]));
    stream.on("data", (chunk) => (bytes += chunk.length));
    stream.on("error", reject);
    stream.on("end", () => {
      const ms = performance.now() - started;
      if (status === 200) resolve({ ms, bytes });
      else reject(new Error(`${route.name} ${path} answered HTTP ${status}`));
    });
    stream.end();
  });
}

function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (share) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
  return `${at(0.5).toFixed(0).padStart(5)} ms median ${at(0.95).toFixed(0).padStart(5)} ms p95`;
}

const cases = [
  {
    name: "small API call, one at a time",
    async run(route, machine) {
      const session = await connect(route);
      await get(session, route, "/api/v1/hosts", machine);
      const samples = [];
      for (let index = 0; index < runs; index += 1) {
        samples.push((await get(session, route, "/api/v1/hosts", machine)).ms);
      }
      session.close();
      return samples;
    },
  },
  {
    name: "35 KB API call, one at a time",
    async run(route, machine) {
      const session = await connect(route);
      await get(session, route, "/api/v1/server/config", machine);
      const samples = [];
      for (let index = 0; index < runs; index += 1) {
        const path = "/api/v1/server/config";
        samples.push((await get(session, route, path, machine)).ms);
      }
      session.close();
      return samples;
    },
  },
  {
    name: "20 API calls at once (time for all)",
    async run(route, machine) {
      const session = await connect(route);
      await get(session, route, "/api/v1/hosts", machine);
      const samples = [];
      for (let round = 0; round < Math.max(5, runs / 4); round += 1) {
        const started = performance.now();
        const batch = Array.from({ length: 20 }, () =>
          get(session, route, "/api/v1/server/config", machine),
        );
        await Promise.all(batch);
        samples.push(performance.now() - started);
      }
      session.close();
      return samples;
    },
  },
  {
    name: "first request on a new connection",
    async run(route, machine) {
      const samples = [];
      for (let index = 0; index < Math.max(5, runs / 4); index += 1) {
        const started = performance.now();
        const session = await connect(route);
        await get(session, route, "/api/v1/hosts", machine);
        samples.push(performance.now() - started);
        session.close();
      }
      return samples;
    },
  },
];

const { code } = await relayCall(
  "/api/connect/machine-code",
  {},
  link.credential,
);
const machine = await relayCall("/api/connect/redeem-machine", { code });
try {
  for (const test of cases) {
    console.log(test.name);
    for (const route of routes) {
      const samples = await test.run(route, machine.credential);
      console.log(`  ${route.name.padEnd(16)} ${summary(samples)}`);
    }
  }
} finally {
  const { machineId } = machine;
  await relayCall(
    "/api/connect/revoke-machine",
    { machineId },
    link.credential,
  );
}
