import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates, createServer as createTlsServer } from "node:tls";
import { promisify } from "node:util";
import { expect, it, onTestFinished, vi } from "vitest";
import type { Link } from "../src/account.js";
import { FrpTunnel, trustedCertificates } from "../src/frp.js";

const FRP_BIN = process.env.FRP_BIN_DIR;
const CREDENTIAL = "bbm_link-credential-that-must-not-leak";
const run = promisify(execFile);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "bb-connect-frp-"));
}

async function freePort(): Promise<number> {
  const server = createNetServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => {
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

async function until(
  check: () => boolean | Promise<boolean>,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function selfSigned(dir: string) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  return { key, cert };
}

async function frpBehindSelfSignedTls(bin: string) {
  const dir = scratch();
  const certificate = await selfSigned(dir);
  const logins: { metas?: { credential?: string } }[] = [];
  const proxies: string[] = [];
  const hooks = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString());
      if (call.op === "Login") logins.push(call.content);
      if (call.op === "NewProxy") proxies.push(call.content.subdomain);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ reject: false, unchange: true }));
    });
  });
  const hooksPort = await listen(hooks);
  const frpsPort = await freePort();
  const config = join(dir, "frps.json");
  writeFileSync(
    config,
    JSON.stringify({
      bindAddr: "127.0.0.1",
      bindPort: frpsPort,
      proxyBindAddr: "127.0.0.1",
      vhostHTTPPort: await freePort(),
      subdomainHost: "frp.test",
      log: { level: "warn", disablePrintColor: true },
      httpPlugins: [
        {
          name: "hooks",
          addr: `127.0.0.1:${hooksPort}`,
          path: "/frp",
          ops: ["Login", "NewProxy"],
        },
      ],
    }),
  );
  const frps = spawn(join(bin, "frps"), ["-c", config], { stdio: "inherit" });
  onTestFinished(() => {
    frps.kill("SIGTERM");
  });

  const decrypted: Buffer[] = [];
  const handshakeErrors: string[] = [];
  const front = createTlsServer({
    key: await readFile(certificate.key),
    cert: await readFile(certificate.cert),
  });
  front.on("tlsClientError", (error) => handshakeErrors.push(error.message));
  front.on("secureConnection", (socket) => {
    const upstream = connect(frpsPort, "127.0.0.1");
    socket.on("data", (chunk: Buffer) => decrypted.push(chunk));
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  const frontPort = await listen(front);
  await until(
    () =>
      new Promise<boolean>((resolve) => {
        const probe = connect(frpsPort, "127.0.0.1");
        probe.on("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.on("error", () => resolve(false));
      }),
  );
  return {
    server: `tls://127.0.0.1:${frontPort}`,
    cert: certificate.cert,
    logins,
    proxies,
    handshakeErrors,
    decrypted: () => Buffer.concat(decrypted).toString("latin1"),
  };
}

function startClient(bin: string, server: string) {
  const log = { info: () => {}, warn: () => {} };
  const dir = scratch();
  const tunnel = new FrpTunnel({
    server,
    binary: join(bin, "frpc"),
    dir,
    loopbackUrl: "http://127.0.0.1:9",
    marker: "marker",
    log,
  });
  const link: Link = {
    baseUrl: "https://getbb.test",
    serverUrl: "https://abc.getbb.test",
    serverId: "srv_1",
    serverLabel: "abc",
    credential: CREDENTIAL,
  };
  tunnel.set(link);
  onTestFinished(() => tunnel.set(null));
  return { dir };
}

it("trusts Node's roots plus NODE_EXTRA_CA_CERTS", async () => {
  expect(await trustedCertificates({})).toEqual([...rootCertificates]);
  const extra = join(scratch(), "extra.pem");
  writeFileSync(
    extra,
    "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n",
  );
  const certificates = await trustedCertificates({
    NODE_EXTRA_CA_CERTS: extra,
  });
  expect(certificates.slice(0, -1)).toEqual([...rootCertificates]);
  expect(certificates.at(-1)).toBe(
    "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
  );
});

it.skipIf(FRP_BIN === undefined)(
  "frpc refuses a TLS front it cannot verify and never sends the credential",
  async () => {
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "");
    const front = await frpBehindSelfSignedTls(FRP_BIN ?? "");
    const client = startClient(FRP_BIN ?? "", front.server);
    await until(
      () => front.handshakeErrors.length >= 2 || front.logins.length > 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(front.logins).toEqual([]);
    expect(front.proxies).toEqual([]);
    expect(front.decrypted()).not.toContain(CREDENTIAL);
    expect(front.decrypted()).toBe("");
    const config = JSON.parse(
      await readFile(join(client.dir, "frpc.json"), "utf8"),
    );
    expect(config.transport.tls).toEqual({
      enable: true,
      serverName: "127.0.0.1",
      trustedCaFile: join(client.dir, "roots.pem"),
    });
  },
);

it.skipIf(FRP_BIN === undefined)(
  "frpc connects through the TLS front when its CA is trusted",
  async () => {
    const front = await frpBehindSelfSignedTls(FRP_BIN ?? "");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", front.cert);
    startClient(FRP_BIN ?? "", front.server);
    await until(() => front.proxies.length > 0);
    expect(front.logins.map((login) => login.metas?.credential)).toContain(
      CREDENTIAL,
    );
    expect(front.proxies).toContain("abc");
    expect(front.handshakeErrors).toEqual([]);
  },
);
