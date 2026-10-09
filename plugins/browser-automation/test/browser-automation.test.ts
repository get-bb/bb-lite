import { createRunnerPlugins, type RunnerEvent } from "@bb/runner";
import { expect, it, onTestFinished } from "vitest";
import { scratch } from "../../../apps/server/test/helpers.js";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { checkProvenance, PIN, sha256SumFor } from "../installer.js";
import { createBrowserRunner, type BrowserSession } from "../runner.js";

type Sent = { name: string; input: Record<string, unknown> };
type CliOutput = { exitCode: number; stdout?: string; stderr?: string };

async function browserServer() {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  const sent: Sent[] = [];
  let exitCode = 0;
  server.runner.script.callOp = async (op) => {
    const { name, input } = op as Sent;
    if (!name.startsWith("browser-automation.")) return null;
    sent.push({ name, input });
    if (name.endsWith("hostPrepare"))
      return { status: "ready", version: PIN.version, source: "release" };
    if (name.endsWith("hostRun"))
      return { text: `ran ${String(input.script)}`, images: [], exitCode };
    return null;
  };
  const cli = async (argv: string[], thread = threadId) => {
    const { body: output } = await server.http<CliOutput>(
      "POST",
      "/plugins/browser-automation/cli",
      {
        argv,
        threadId: thread,
      },
    );
    return { ...output, json: () => JSON.parse(output.stdout ?? "null") };
  };
  const hostId = server.ctx.config.hostId;
  const setExit = (code: number) => void (exitCode = code);
  return { ...server, threadId, hostId, sent, cli, setExit };
}

it("opens a local session, runs scripts on its machine and stops it", async () => {
  const { cli, hostId, threadId, sent, setExit } = await browserServer();
  const open = await cli([
    "open",
    "--backend",
    "local",
    "--headless",
    "--machine",
    hostId,
    "--json",
  ]);
  const session = open.json();
  expect(session).toMatchObject({ threadId, hostId, backend: "local" });
  expect(session.previewDirective).toBe(
    `::browser-preview{session="${session.id}"}`,
  );
  expect(sent.map((s) => s.name)).toEqual([
    "browser-automation.hostPrepare",
    "browser-automation.hostOpen",
  ]);

  const ran = await cli([
    "run",
    session.id,
    "--script",
    "1+1",
    "--timeout",
    "90s",
    "--json",
  ]);
  expect(ran.json()).toEqual({
    text: "ran 1+1",
    images: [],
    exitCode: 0,
    hostId,
  });
  expect(sent.at(-1)?.input).toMatchObject({
    script: "1+1",
    timeoutMs: 90_000,
  });
  expect((await cli(["pages", session.id, "--json"])).json().text).toBe(
    "ran await browser.listPages()",
  );

  setExit(124);
  expect(
    (await cli(["run", session.id, "--script", "x", "--json"])).exitCode,
  ).toBe(124);
  const after = await cli(["run", session.id, "--script", "x", "--json"]);
  expect(after.json()).toEqual({
    ok: false,
    error: {
      code: "session_unavailable",
      message: "Session stopped or expired; open a new session",
      hint: "Open a new session with `bb browser-automation open --backend <desktop|local> --machine <host-id>`.",
    },
  });
  expect((await cli(["list", "--json"])).json()[0].state).toBe("stopped");
});

it("refuses the desktop backend, other threads and bad flags", async () => {
  const { cli, hostId } = await browserServer();
  const desktop = await cli([
    "open",
    "--backend",
    "desktop",
    "--desktop",
    "d1",
    "--machine",
    hostId,
    "--json",
  ]);
  expect(desktop.json().error.code).toBe("desktop_unavailable");
  const mixed = await cli([
    "open",
    "--backend",
    "local",
    "--machine",
    hostId,
    "--json",
  ]);
  expect(mixed.json().error.code).toBe("invalid_selection");
  const unknown = await cli([
    "open",
    "--backend",
    "local",
    "--headless",
    "--machine",
    "nope",
    "--json",
  ]);
  expect(unknown.json().error.message).toBe("Machine 'nope' was not found");
  const other = await cli(["list", "--thread", "thr_other", "--json"]);
  expect(other.json().error.code).toBe("cross_thread");
});

function fakeRuntime() {
  const log: string[] = [];
  let release: () => void = () => undefined;
  const session: BrowserSession = {
    async run(script) {
      log.push(`start ${script}`);
      if (script === "slow") await new Promise<void>((r) => (release = r));
      log.push(`end ${script}`);
      return { text: script, images: [], exitCode: 0 };
    },
    preview(size, onFrame) {
      onFrame({
        sequence: 1,
        mimeType: "image/jpeg",
        data: "AAAA",
        width: 8,
        height: 8,
        url: "about:blank",
        title: size,
      });
    },
    async close() {
      log.push("closed");
    },
  };
  return { log, session, release: () => release() };
}

it("serializes runs per session, emits preview frames and closes on expiry", async () => {
  const fake = fakeRuntime();
  const events: RunnerEvent[] = [];
  let now = 1_000;
  const runners = createRunnerPlugins({
    dataDir: scratch(),
    sink: (e) => void events.push(e),
  });
  onTestFinished(() => runners.dispose());
  const entry = createBrowserRunner(
    () => ({
      prepare: async () => ({ version: "v" }),
      open: async () => fake.session,
    }),
    () => now,
  );
  runners.load({ id: "browser-automation", entry });
  const call = (name: string, input: object) =>
    runners.callOp(`browser-automation.${name}`, input);
  const sessionId = "8d0f6c55-3a8b-4f7e-9a51-6f0b8f3d2c11";
  expect(await call("hostPrepare", {})).toEqual({
    status: "ready",
    version: "v",
    source: "release",
  });
  await call("hostOpen", {
    sessionId,
    expiresAt: 10_000,
    idleTimeoutMs: 5_000,
  });
  const slow = call("hostRun", { sessionId, script: "slow", timeoutMs: 5_000 });
  const fast = call("hostRun", { sessionId, script: "fast", timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 20));
  expect(fake.log).toEqual(["start slow"]);
  fake.release();
  await Promise.all([slow, fast]);
  expect(fake.log).toEqual([
    "start slow",
    "end slow",
    "start fast",
    "end fast",
  ]);

  await call("hostPreview", { sessionId, size: "full" });
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "plugin.event",
      name: "browser-automation.previewFrame",
    }),
  );

  now = 20_000;
  await new Promise((r) => setTimeout(r, 1_100));
  expect(fake.log.at(-1)).toBe("closed");
  await expect(
    call("hostRun", { sessionId, script: "x", timeoutMs: 5_000 }),
  ).rejects.toThrow(/open a new session/u);
});

it("checks the pinned digest list and npm provenance without downloading", () => {
  const digest = PIN.sha256["linux-x64"]!;
  expect(
    sha256SumFor(`${digest}  dev-browser-linux-x64\n`, "dev-browser-linux-x64"),
  ).toBe(digest);
  const sha512 = Buffer.alloc(64, 7);
  const statement = {
    subject: [
      {
        name: `pkg:npm/dev-browser@${PIN.version}`,
        digest: { sha512: sha512.toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/SawyerHood/dev-browser",
            ref: `refs/tags/v${PIN.version}`,
          },
        },
      },
    },
  };
  const body = (s: object) => ({
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(s)).toString("base64"),
          },
        },
      },
    ],
  });
  const integrity = `sha512-${sha512.toString("base64")}`;
  expect(() => checkProvenance(body(statement), integrity)).not.toThrow();
  expect(() =>
    checkProvenance(
      body(statement),
      `sha512-${Buffer.alloc(64).toString("base64")}`,
    ),
  ).toThrow(/does not cover/u);
});

it("serves live preview frames to the app and closes sessions when the thread is archived", async () => {
  const server = await browserServer();
  const { cli, hostId, threadId, sent } = server;
  const session = (
    await cli(["open", "--backend", "local", "--headless", "--machine", hostId])
  ).json();
  const frame = {
    sequence: 3,
    mimeType: "image/jpeg",
    data: "AAAA",
    width: 800,
    height: 450,
    url: "https://example.test",
    title: "Example",
  };
  const answer = server.runner.script.callOp;
  server.runner.script.callOp = async (op, ...rest) => {
    const { name } = op as Sent;
    if (name.endsWith("hostPreview"))
      setTimeout(
        () =>
          void server.emit({
            kind: "plugin.event",
            name: "browser-automation.previewFrame",
            payload: { sessionId: session.id, size: "thumbnail", frame },
          }),
        10,
      );
    return answer?.(op, ...rest);
  };
  const { body } = await server.http<{
    result: { frame: typeof frame | null };
  }>("POST", "/ops/browser-automation.preview", {
    threadId,
    sessionId: session.id,
  });
  expect(body.result.frame).toEqual(frame);

  await server.ctx.threads.archive(threadId);
  await expect
    .poll(() => sent.at(-1)?.name)
    .toBe("browser-automation.hostClose");
  const listed = (await cli(["list"])).json();
  expect(listed[0]).toMatchObject({ id: session.id, state: "closed" });
});
