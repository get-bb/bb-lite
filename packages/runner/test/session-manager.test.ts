import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStandaloneBuiltinCompactCommandInput,
  encodeClientTurnRequestIdNumber,
  threadEventSchema,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  Outbox,
  RunnerError,
  buildAgentEnv,
  createSessionApi,
  parseShellPath,
  type ExecutionOptions,
  type ProviderAdapter,
  type RunnerEvent,
  type RunnerThreadEvent,
  type SessionTiming,
  type SubmitTurnArgs,
} from "@bb/runner";
import { createEchoAdapter } from "../../../plugins/provider-echo/runner/echo.js";
import { until } from "./kit.js";

type Kind = RunnerEvent["kind"];
type OfKind<K extends Kind> = Extract<RunnerEvent, { kind: K }>;

const THREAD = "thr_echo";
const PROVIDER_THREAD = "echo-thr_echo";
const START = { kind: "start" as const };
const OPTIONS: ExecutionOptions = {
  model: "echo-1",
  reasoningLevel: "medium",
  serviceTier: "default",
  permissionMode: "accept-edits",
  permissionEscalation: "ask",
  providerOptions: {},
};
const SESSION = {
  threadId: THREAD,
  providerId: "echo" as const,
  cwd: "/work",
  instructions: "",
  dynamicTools: [],
  env: { BB_THREAD_ID: THREAD, API_TOKEN: "secret" },
  skillDirs: [],
};
const cleanups: (() => Promise<void>)[] = [];
let requestCounter = 0;

function turn(
  text: string,
  mode: SubmitTurnArgs["mode"] = START,
  providerThreadId: string | null = null,
  options = OPTIONS,
): SubmitTurnArgs {
  requestCounter += 1;
  const clientRequestId = encodeClientTurnRequestIdNumber({
    value: requestCounter,
  });
  const input = [{ type: "text" as const, text, mentions: [] }];
  const session = { ...SESSION, providerThreadId };
  return { session, clientRequestId, input, options, mode };
}

async function setup(
  timing: Partial<SessionTiming> = {},
  adapter: ProviderAdapter = createEchoAdapter(),
) {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-runner-test-"));
  const received: RunnerEvent[] = [];
  const outbox = new Outbox((event) => received.push(event), 5);
  const api = createSessionApi({
    dataDir,
    serverUrl: "http://127.0.0.1:48901",
    bbCliPath: "/opt/bb/bin/bb",
    outbox,
    adapters: [adapter],
    loginPath: async () => "/usr/bin:/bin",
    timing,
  });
  cleanups.push(async () => {
    await api.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });
  const events = () =>
    received.flatMap((e) => (e.kind === "thread.events" ? e.events : []));
  const ofType = <T extends RunnerThreadEvent["type"]>(type: T) =>
    events().filter(
      (e): e is Extract<RunnerThreadEvent, { type: T }> => e.type === type,
    );
  const ofKind = <K extends Kind>(kind: K) =>
    received.filter((event): event is OfKind<K> => event.kind === kind);
  const completed = (count: number) =>
    until(() => ofType("turn/completed").length >= count);
  const replies = () =>
    ofType("item/completed").flatMap(({ item }) =>
      item.type === "agentMessage" ? [item.text] : [],
    );
  const activeTurn = () =>
    until(async () => (await api.snapshot()).sessions[0]?.activeTurnId);
  const kit = { events, ofType, ofKind, completed, replies, activeTurn };
  return { api, dataDir, outbox, received, ...kit };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error: unknown = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(RunnerError);
  expect(error).toMatchObject({ code });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("session manager with the echo provider", () => {
  it("runs a scripted turn through the reliable outbox", async () => {
    const { api, dataDir, events, ofType, replies, completed, ...run } =
      await setup();
    const prompt = "think:plan cmd:ls edit:src/a.ts tool:grep subagent:scout";
    const started = await api.submitTurn(turn(`${prompt} stream:3 hello`));
    expect(started).toEqual({
      outcome: "started",
      providerThreadId: PROVIDER_THREAD,
    });
    await completed(2);
    for (const event of events()) {
      threadEventSchema.parse({ ...event, threadId: THREAD });
    }
    const shape = events().map((event) =>
      "item" in event ? `${event.type}:${event.item.type}` : event.type,
    );
    expect(shape.slice(0, 7)).toEqual([
      "thread/identity",
      "thread/started",
      "provider.env-resolved",
      "turn/started",
      "turn/input/accepted",
      "item/started:reasoning",
      "item/reasoning/textDelta",
    ]);
    expect(shape).toEqual(
      expect.arrayContaining([
        "item/commandExecution/outputDelta",
        "item/completed:commandExecution",
        "item/completed:fileChange",
        "item/toolCall/progress",
        "item/completed:toolCall",
        "item/completed:delegation",
        "thread/tokenUsage/updated",
        "thread/contextWindowUsage/updated",
      ]),
    );
    const [, child] = ofType("turn/started");
    const delegation = ofType("item/started").find(
      ({ item }) => item.type === "delegation",
    );
    expect(child.parentToolCallId).toBe(delegation?.item.id);
    expect(ofType("item/agentMessage/delta").length).toBeGreaterThan(1);
    expect(replies().at(-1)).toBe(`Response to: ${prompt} stream:3 hello`);
    const outcome = { status: "completed", providerCheckpointId: "turn-1" };
    expect(events().at(-1)).toMatchObject(outcome);

    const [{ entries }] = ofType("provider.env-resolved");
    const env = Object.fromEntries(entries.map((e) => [e.name, e.value]));
    expect(env).toMatchObject({
      PATH: "/opt/bb/bin:/usr/bin:/bin",
      BB_CLI: "/opt/bb/bin/bb",
      BB_SERVER_URL: "http://127.0.0.1:48901",
      BB_THREAD_STORAGE: join(dataDir, "thread-storage", THREAD),
      BB_THREAD_ID: THREAD,
      API_TOKEN: { masked: true },
    });

    const seqs = run.received.map((event) => ("seq" in event ? event.seq : -1));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    const session = {
      threadId: THREAD,
      providerId: "echo",
      activeTurnId: null,
    };
    expect(await api.snapshot()).toMatchObject({
      lastEventSeq: seqs.length,
      sessions: [{ ...session, providerThreadId: PROVIDER_THREAD }],
    });
    await api.ackEvents({ seq: seqs.length - 2 });
    run.received.length = 0;
    run.outbox.resendAfter(0);
    const resent = run.received.map((event) => "seq" in event && event.seq);
    expect(resent).toEqual(seqs.slice(-2));

    expect(await api.describe()).toMatchObject({
      dataDir,
      threadStorageRoot: join(dataDir, "thread-storage"),
    });
    const ready = { providerId: "echo", installed: true, auth: "ready" };
    expect(await api.listProviders()).toMatchObject([ready]);
    const { models } = await api.listModels({ providerId: "echo", cwd: null });
    expect(models.map((model) => model.isDefault)).toEqual([true, false]);
    const unknown = api.listModels({ providerId: "codex", cwd: null });
    await expectCode(unknown, "unavailable");

    const baseEnv = { HOME: "/u", NODE_ENV: "test", BB_THREAD_ID: "thr_x" };
    const paths = { bbCliPath: "/opt/bb/bin/bb", loginPath: "/usr/bin" };
    const urls = { serverUrl: "http://s", threadStorageDir: "/data/t" };
    const scrubbed = buildAgentEnv({ ...paths, ...urls, specEnv: {}, baseEnv });
    expect(scrubbed.process).toEqual({
      HOME: "/u",
      PATH: "/opt/bb/bin:/usr/bin",
    });
    const probe =
      "motd\n__BB_SHELL_ENV_START__\nPATH=/a:/b\n__BB_SHELL_ENV_END__\n";
    expect(parseShellPath(probe)).toBe("/a:/b");
  });

  it("applies the start, steer and auto rules to a running turn", async () => {
    const { api, ofType, replies, completed, activeTurn } = await setup();
    await api.submitTurn(turn("hold_turn"));
    const turnId = await activeTurn();
    await expectCode(api.submitTurn(turn("again")), "competing_turn");
    const wrong = { kind: "steer" as const, expectedTurnId: "da00000000-t9" };
    await expectCode(api.submitTurn(turn("nudge", wrong)), "stale_turn");

    const auto = await api.submitTurn(turn("nudge", { kind: "auto" }));
    expect(auto).toMatchObject({ outcome: "steered", turnId });
    const expected = { kind: "steer" as const, expectedTurnId: turnId };
    const release = turn("release_turn", expected);
    const repeated = [api.submitTurn(release), api.submitTurn(release)];
    expect(await repeated[0]).toEqual(await repeated[1]);
    await completed(1);
    const accepted = ofType("turn/input/accepted").map((event) => event.scope);
    expect(accepted).toEqual(Array(3).fill({ kind: "turn", turnId }));
    expect(replies()).toEqual(["Steered: nudge", "Steered: release_turn"]);

    await expectCode(api.submitTurn(turn("late", expected)), "stale_turn");
    const next = await api.submitTurn(turn("fresh", { kind: "auto" }));
    expect(next.outcome).toBe("started");
    await completed(2);
    expect(ofType("turn/started")).toHaveLength(2);
  });

  it("interrupts through the provider and settles itself when it must", async () => {
    const { api, ofType, ofKind, activeTurn } = await setup({
      interruptTimeoutMs: 150,
    });
    const stop = () => api.interruptTurn({ threadId: THREAD });
    expect(await stop()).toEqual({ interrupted: false });
    await api.submitTurn(turn("hold_turn"));
    await activeTurn();
    expect(await stop()).toEqual({ interrupted: true });
    expect(ofType("turn/completed")).toMatchObject([{ status: "interrupted" }]);
    expect((await api.snapshot()).sessions).toEqual([]);

    const stubborn = "ignore_interrupt approve go";
    await api.submitTurn(turn(stubborn, START, PROVIDER_THREAD));
    const { requestId, turnId } = await until(
      () => ofKind("interaction.requested")[0],
    );
    expect((await api.snapshot()).pendingRequestIds).toEqual([requestId]);
    expect(await stop()).toEqual({ interrupted: true });
    const settled = { status: "interrupted", scope: { turnId } };
    expect(ofType("turn/completed").at(-1)).toMatchObject(settled);
    expect(ofKind("interaction.cancelled")).toMatchObject([{ requestId }]);
    const late = { decision: "deny" as const };
    const delivery = { threadId: THREAD, requestId, resolution: late };
    expect(await api.resolveInteraction(delivery)).toEqual({
      delivered: false,
    });
    const empty = { sessions: [], pendingRequestIds: [] };
    expect(await api.snapshot()).toMatchObject(empty);
  });

  it("routes a standalone /compact to the session's compact", async () => {
    const echo = createEchoAdapter();
    const compactions: string[] = [];
    const adapter: ProviderAdapter = {
      ...echo,
      async open(spec, options, host) {
        const session = await echo.open(spec, options, host);
        return Object.assign(session, {
          async compact() {
            compactions.push(session.providerThreadId);
            host.events.openTurn();
            host.events.compacted();
            host.events.closeTurn({ status: "completed" });
          },
        });
      },
    };
    const { api, ofType, completed, replies } = await setup({}, adapter);
    const compact = turn("count");
    compact.input = createStandaloneBuiltinCompactCommandInput();
    await api.submitTurn(compact);
    await completed(1);
    expect(compactions).toEqual([PROVIDER_THREAD]);
    expect(ofType("thread/compacted")).toHaveLength(1);
    const accepted = ofType("turn/input/accepted");
    expect(accepted.map((e) => e.clientRequestId)).toEqual([
      compact.clientRequestId,
    ]);
    await api.submitTurn(turn("count"));
    await completed(2);
    expect(replies()).toEqual(["Turn count: 1"]);
  });

  it("resumes a released session from its provider thread id", async () => {
    const { api, ofType, replies, completed } = await setup();
    const { providerThreadId } = await api.submitTurn(turn("count"));
    await completed(1);
    await api.releaseSession({ threadId: THREAD });
    expect((await api.snapshot()).sessions).toEqual([]);

    await api.submitTurn(turn("count", START, providerThreadId));
    await completed(2);
    expect(replies()).toEqual(["Turn count: 1", "Turn count: 2"]);
    const identity = { providerThreadId };
    expect(ofType("thread/identity")).toMatchObject([identity, identity]);
    expect(ofType("thread/started")).toHaveLength(1);
    expect(ofType("provider.env-resolved")).toHaveLength(2);
    const prefixes = ofType("turn/completed").map(
      ({ scope }) => scope.kind === "turn" && scope.turnId.split("-")[0],
    );
    expect(new Set(prefixes).size).toBe(2);
  });

  it("round-trips approvals and denies them itself when told to", async () => {
    const { api, ofKind, replies, completed, activeTurn, ...run } =
      await setup();
    const decisions = [
      { decision: "allow_once" as const, grantedPermissions: null },
      { decision: "deny" as const },
    ];
    for (const [index, resolution] of decisions.entries()) {
      await api.submitTurn(turn("approve ship"));
      const request = await until(() => ofKind("interaction.requested")[index]);
      expect(request).toMatchObject({
        threadId: THREAD,
        providerId: "echo",
        providerThreadId: PROVIDER_THREAD,
        turnId: await activeTurn(),
        payload: { kind: "approval", subject: { kind: "command" } },
      });
      const opened = run.received.findIndex(
        (event) =>
          event.kind === "thread.events" &&
          event.events.some((e) => e.type === "turn/started"),
      );
      expect(opened).toBeLessThan(run.received.indexOf(request));
      const delivery = { threadId: THREAD, requestId: request.requestId };
      const first = await api.resolveInteraction({ ...delivery, resolution });
      const second = await api.resolveInteraction({ ...delivery, resolution });
      expect([first.delivered, second.delivered]).toEqual([true, false]);
      await completed(index + 1);
    }
    const unattended = { ...OPTIONS, permissionEscalation: "deny" as const };
    await api.submitTurn(
      turn("approve ship", START, PROVIDER_THREAD, unattended),
    );
    await completed(3);
    expect(ofKind("interaction.requested")).toHaveLength(2);
    expect(replies()).toEqual([
      "Response to: approve ship",
      "Denied",
      "Denied",
    ]);

    await api.submitTurn(turn("ask_user"));
    const question = await until(() => ofKind("interaction.requested")[2]);
    const { payload, requestId } = question;
    const questionId =
      payload.kind === "user_question" && payload.questions[0].id;
    const answer = { selected: ["staging"], freeText: "soon" };
    const answers = { [String(questionId)]: answer };
    const resolution = { kind: "user_answer" as const, answers };
    await api.resolveInteraction({ threadId: THREAD, requestId, resolution });
    await completed(4);
    expect(replies().at(-1)).toBe("Question answered: staging, soon");
  });

  it("round-trips a dynamic tool call through the server", async () => {
    const { api, ofType, ofKind, replies, completed, activeTurn } =
      await setup();
    await api.submitTurn(turn("call_tool:lookup"));
    const request = await until(() => ofKind("toolCall.requested")[0]);
    const isCall = (event: { item: { type: string } }) =>
      event.item.type === "toolCall";
    expect(request).toMatchObject({
      tool: "lookup",
      arguments: {},
      turnId: await activeTurn(),
      callId: ofType("item/started").find(isCall)?.item.id,
    });
    const contentItems = [{ type: "inputText" as const, text: "42" }];
    const result = { success: true, contentItems };
    const delivery = { threadId: THREAD, requestId: request.requestId, result };
    expect(await api.resolveToolCall(delivery)).toEqual({ delivered: true });
    await completed(1);
    const call = { server: "bb", tool: "lookup", result: "42" };
    expect(ofType("item/completed").find(isCall)).toMatchObject({
      item: { ...call, status: "completed" },
    });
    expect(replies()).toEqual(["Tool called: lookup"]);
  });

  it("reports provider death, failed and stalled turns", async () => {
    const timing = { turnStartTimeoutMs: 30, watchdogIntervalMs: 10 };
    const { api, ofType, completed, dataDir } = await setup({
      ...timing,
      interruptTimeoutMs: 50,
    });
    await api.submitTurn(turn("crash"));
    const [exited] = await until(() => ofType("system/error"));
    const [failed] = ofType("turn/completed");
    const message = expect.stringContaining("exited unexpectedly");
    expect(failed).toMatchObject({ status: "failed", error: { message } });
    expect(exited).toMatchObject({
      code: "provider_process_exited",
      detail: "stderr:\nscripted crash",
      scope: failed.scope,
    });
    expect((await api.snapshot()).sessions).toEqual([]);

    await api.submitTurn(turn("fail_turn:quota_exhausted"));
    await completed(2);
    const quota = { detail: "quota exhausted", willRetry: false };
    expect(ofType("provider/error")).toMatchObject([quota]);
    expect(ofType("turn/completed")[1]).toMatchObject({ status: "failed" });

    await api.submitTurn(turn("swallow_turn"));
    await expectCode(api.submitTurn(turn("second")), "competing_turn");
    const stalled = await until(() => ofType("system/error")[1]);
    expect(stalled).toMatchObject({
      code: "provider_turn_start_timeout",
      scope: { kind: "thread" },
    });

    const storage = join(dataDir, "thread-storage", THREAD);
    expect(existsSync(join(storage, "echo-state.json"))).toBe(true);
    await api.deleteThreadStorage({ threadId: THREAD });
    expect(existsSync(storage)).toBe(false);
    expect((await api.snapshot()).sessions).toEqual([]);
    const escaping = api.deleteThreadStorage({ threadId: "../x" });
    await expectCode(escaping, "invalid_path");
  });
});
