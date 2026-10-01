import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClientTurnRequestIdNumber, threadEventSchema } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  Outbox,
  RunnerError,
  createEchoAdapter,
  createSessionApi,
  type ExecutionOptions,
  type ManagedSessionApi,
  type RunnerEvent,
  type RunnerThreadEvent,
  type SessionTiming,
  type SubmitTurnArgs,
} from "@bb/runner";

type Requested<K extends RunnerEvent["kind"]> = Extract<
  RunnerEvent,
  { kind: K }
>;

const THREAD = "thr_echo";
const cleanups: (() => Promise<void>)[] = [];
let requestCounter = 0;

function nextRequestId() {
  requestCounter += 1;
  return encodeClientTurnRequestIdNumber({ value: requestCounter });
}

async function setup(timing: Partial<SessionTiming> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-runner-test-"));
  const received: RunnerEvent[] = [];
  const outbox = new Outbox((event) => received.push(event), 5);
  const api = createSessionApi({
    dataDir,
    serverUrl: "http://127.0.0.1:48901",
    bbCliPath: "/opt/bb/bin/bb",
    outbox,
    adapters: [createEchoAdapter()],
    loginPath: async () => "/usr/bin:/bin",
    timing,
  });
  cleanups.push(async () => {
    await api.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });
  const threadEvents = () =>
    received.flatMap((event) =>
      event.kind === "thread.events" ? event.events : [],
    );
  const find = <K extends RunnerEvent["kind"]>(kind: K) =>
    received.filter((event): event is Requested<K> => event.kind === kind);
  return { api, dataDir, outbox, received, threadEvents, find };
}

function turn(
  text: string,
  mode: SubmitTurnArgs["mode"] = { kind: "start" },
  overrides: {
    providerThreadId?: string;
    options?: Partial<ExecutionOptions>;
  } = {},
): SubmitTurnArgs {
  return {
    session: {
      threadId: THREAD,
      providerId: "echo",
      cwd: "/work",
      providerThreadId: overrides.providerThreadId ?? null,
      fork: null,
      instructions: "",
      dynamicTools: [],
      env: { BB_THREAD_ID: THREAD, API_TOKEN: "secret" },
      skillDirs: [],
    },
    clientRequestId: nextRequestId(),
    input: [{ type: "text", text, mentions: [] }],
    options: {
      model: "echo-1",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      permissionEscalation: "ask",
      planMode: false,
      providerOptions: {},
      ...overrides.options,
    },
    mode,
  };
}

type Awaitable<T> = T | Promise<T>;

async function until<T>(
  read: () => Awaitable<T | undefined | false | null>,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached in 5 s");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function completions(events: RunnerThreadEvent[]) {
  return events.filter((event) => event.type === "turn/completed");
}

function replies(events: RunnerThreadEvent[]) {
  return events.flatMap((event) =>
    event.type === "item/completed" && event.item.type === "agentMessage"
      ? [event.item.text]
      : [],
  );
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RunnerError);
  expect(error).toMatchObject({ code });
}

function activeTurn(api: ManagedSessionApi) {
  return until(async () => (await api.snapshot()).sessions[0]?.activeTurnId);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("session manager with the echo provider", () => {
  it("starts a session and emits a schema-valid scripted turn", async () => {
    const { api, threadEvents, received, outbox } = await setup();
    const prompt =
      "think:plan_it cmd:ls edit:src/a.ts tool:grep subagent:scout";
    const result = await api.submitTurn(turn(`${prompt} stream:3 hello`));
    expect(result).toEqual({
      outcome: "started",
      providerThreadId: "echo-thr_echo",
    });
    await until(() => completions(threadEvents()).length === 2);
    const events = threadEvents();
    for (const event of events) {
      threadEventSchema.parse({ ...event, threadId: THREAD });
    }
    const shape = events.map((event) =>
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
    const child = events.find(
      (event) => event.type === "turn/started" && event.parentToolCallId,
    );
    const delegation = events.find(
      (event) =>
        event.type === "item/started" && event.item.type === "delegation",
    );
    expect(child).toMatchObject({
      parentToolCallId:
        delegation && "item" in delegation && delegation.item.id,
    });
    const deltas = events.filter((e) => e.type === "item/agentMessage/delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(replies(events).at(-1)).toBe(
      `Response to: ${prompt} stream:3 hello`,
    );
    expect(events.at(-1)).toMatchObject({
      status: "completed",
      providerCheckpointId: "turn-1",
    });

    const resolved = events.find((e) => e.type === "provider.env-resolved");
    const entries =
      resolved?.type === "provider.env-resolved" ? resolved.entries : [];
    const byName = Object.fromEntries(
      entries.map((entry) => [entry.name, entry]),
    );
    expect(byName.PATH).toMatchObject({
      source: "shell",
      value: "/opt/bb/bin:/usr/bin:/bin",
    });
    expect(byName.BB_CLI?.value).toBe("/opt/bb/bin/bb");
    expect(byName.BB_SERVER_URL?.value).toBe("http://127.0.0.1:48901");
    expect(byName.BB_THREAD_ID).toMatchObject({
      source: "shell",
      value: THREAD,
    });
    expect(byName.API_TOKEN?.value).toEqual({ masked: true });

    const seqs = received.map((event) => ("seq" in event ? event.seq : -1));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    const snapshot = await api.snapshot();
    expect(snapshot.lastEventSeq).toBe(seqs.length);
    expect(snapshot.sessions).toEqual([
      {
        threadId: THREAD,
        providerId: "echo",
        providerThreadId: "echo-thr_echo",
        activeTurnId: null,
      },
    ]);
    await api.ackEvents({ seq: seqs.length - 2 });
    received.length = 0;
    outbox.resendAfter(0);
    expect(received.map((event) => "seq" in event && event.seq)).toEqual(
      seqs.slice(-2),
    );
  });

  it("applies the start, steer and auto rules to a running turn", async () => {
    const { api, threadEvents } = await setup();
    await api.submitTurn(turn("hold_turn"));
    const turnId = await activeTurn(api);
    await expectCode(api.submitTurn(turn("again")), "competing_turn");
    const wrongTurn = {
      kind: "steer" as const,
      expectedTurnId: "da00000000-t9",
    };
    await expectCode(api.submitTurn(turn("nudge", wrongTurn)), "stale_turn");

    const auto = await api.submitTurn(turn("nudge", { kind: "auto" }));
    expect(auto).toMatchObject({ outcome: "steered", turnId });
    const steer = turn("release_turn", {
      kind: "steer",
      expectedTurnId: turnId,
    });
    const repeated = [api.submitTurn(steer), api.submitTurn(steer)];
    expect(await repeated[0]).toEqual(await repeated[1]);
    await until(() => completions(threadEvents()).length === 1);
    const accepted = threadEvents().filter(
      (e) => e.type === "turn/input/accepted",
    );
    expect(accepted).toHaveLength(3);
    expect(
      accepted.every(
        (e) => e.scope.kind === "turn" && e.scope.turnId === turnId,
      ),
    );
    expect(replies(threadEvents())).toEqual([
      "Steered: nudge",
      "Steered: release_turn",
    ]);

    const stale = { kind: "steer" as const, expectedTurnId: turnId };
    await expectCode(api.submitTurn(turn("late", stale)), "stale_turn");
    const next = await api.submitTurn(turn("fresh", { kind: "auto" }));
    expect(next.outcome).toBe("started");
    await until(() => completions(threadEvents()).length === 2);
    const started = threadEvents().filter((e) => e.type === "turn/started");
    expect(started).toHaveLength(2);
  });

  it("interrupts through the provider and settles itself when it must", async () => {
    const { api, threadEvents, find } = await setup({
      interruptTimeoutMs: 150,
    });
    expect(await api.interruptTurn({ threadId: THREAD })).toEqual({
      interrupted: false,
    });
    await api.submitTurn(turn("hold_turn"));
    await activeTurn(api);
    expect(await api.interruptTurn({ threadId: THREAD })).toEqual({
      interrupted: true,
    });
    expect(completions(threadEvents())).toMatchObject([
      { status: "interrupted" },
    ]);
    expect((await api.snapshot()).sessions).toEqual([]);

    const stubborn = "ignore_interrupt approve:command go";
    const resumed = turn(stubborn, undefined, {
      providerThreadId: "echo-thr_echo",
    });
    await api.submitTurn(resumed);
    const [request] = await until(() => {
      const requests = find("interaction.requested");
      return requests.length > 0 && requests;
    });
    expect((await api.snapshot()).pendingRequestIds).toEqual([
      request.requestId,
    ]);
    expect(await api.interruptTurn({ threadId: THREAD })).toEqual({
      interrupted: true,
    });
    expect(completions(threadEvents()).at(-1)).toMatchObject({
      status: "interrupted",
      scope: { turnId: request.turnId },
    });
    expect(find("interaction.cancelled")).toMatchObject([
      { requestId: request.requestId },
    ]);
    const late = { decision: "deny" as const };
    const delivery = { threadId: THREAD, requestId: request.requestId };
    expect(
      await api.resolveInteraction({ ...delivery, resolution: late }),
    ).toEqual({
      delivered: false,
    });
    expect(await api.snapshot()).toMatchObject({
      sessions: [],
      pendingRequestIds: [],
    });
  });

  it("resumes a released session from its provider thread id", async () => {
    const { api, threadEvents } = await setup();
    const first = await api.submitTurn(turn("count"));
    await until(() => completions(threadEvents()).length === 1);
    await api.releaseSession({ threadId: THREAD });
    expect((await api.snapshot()).sessions).toEqual([]);

    const { providerThreadId } = first;
    await api.submitTurn(turn("count", undefined, { providerThreadId }));
    await until(() => completions(threadEvents()).length === 2);
    expect(replies(threadEvents())).toEqual(["Turn count: 1", "Turn count: 2"]);
    const events = threadEvents();
    const identities = events.filter((e) => e.type === "thread/identity");
    expect(identities).toMatchObject([
      { providerThreadId },
      { providerThreadId },
    ]);
    expect(events.filter((e) => e.type === "thread/started")).toHaveLength(1);
    expect(
      events.filter((e) => e.type === "provider.env-resolved"),
    ).toHaveLength(2);
    const turnIds = completions(events).map(
      (e) => e.scope.kind === "turn" && e.scope.turnId.split("-")[0],
    );
    expect(new Set(turnIds).size).toBe(2);
  });

  it("round-trips approvals and denies them itself when told to", async () => {
    const { api, threadEvents, find, received } = await setup();
    const decisions = [
      { decision: "allow_once" as const, grantedPermissions: null },
      { decision: "deny" as const },
    ];
    for (const [index, resolution] of decisions.entries()) {
      await api.submitTurn(turn("approve:command ship"));
      const request = await until(() => find("interaction.requested")[index]);
      expect(request).toMatchObject({
        threadId: THREAD,
        providerId: "echo",
        providerThreadId: "echo-thr_echo",
        turnId: await activeTurn(api),
        payload: { kind: "approval", subject: { kind: "command" } },
      });
      const opened = received.findIndex(
        (event) =>
          event.kind === "thread.events" &&
          event.events.some((e) => e.type === "turn/started"),
      );
      expect(opened).toBeLessThan(received.indexOf(request));
      const delivery = { threadId: THREAD, requestId: request.requestId };
      expect(await api.resolveInteraction({ ...delivery, resolution })).toEqual(
        {
          delivered: true,
        },
      );
      expect(await api.resolveInteraction({ ...delivery, resolution })).toEqual(
        {
          delivered: false,
        },
      );
      await until(() => completions(threadEvents()).length === index + 1);
    }
    const unattended = { options: { permissionEscalation: "deny" as const } };
    await api.submitTurn(turn("approve:command ship", undefined, unattended));
    await until(() => completions(threadEvents()).length === 3);
    expect(find("interaction.requested")).toHaveLength(2);
    expect(replies(threadEvents())).toEqual([
      "Response to: approve:command ship",
      "Denied",
      "Denied",
    ]);

    await api.submitTurn(turn("ask_user"));
    const question = await until(() => find("interaction.requested")[2]);
    const [questionId] =
      question.payload.kind === "user_question"
        ? question.payload.questions.map((q) => q.id)
        : [];
    await api.resolveInteraction({
      threadId: THREAD,
      requestId: question.requestId,
      resolution: {
        kind: "user_answer",
        answers: { [questionId]: { selected: ["staging"], freeText: "soon" } },
      },
    });
    await until(() => completions(threadEvents()).length === 4);
    expect(replies(threadEvents()).at(-1)).toBe(
      "Question answered: staging, soon",
    );
  });

  it("round-trips a dynamic tool call through the server", async () => {
    const { api, threadEvents, find } = await setup();
    await api.submitTurn(turn("call_tool:lookup"));
    const [request] = await until(() => {
      const requests = find("toolCall.requested");
      return requests.length > 0 && requests;
    });
    const started = threadEvents().find(
      (event) =>
        event.type === "item/started" && event.item.type === "toolCall",
    );
    expect(request).toMatchObject({
      tool: "lookup",
      arguments: {},
      turnId: await activeTurn(api),
      callId: started && "item" in started && started.item.id,
    });
    const result = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "42" }],
    };
    const delivery = { threadId: THREAD, requestId: request.requestId, result };
    expect(await api.resolveToolCall(delivery)).toEqual({ delivered: true });
    await until(() => completions(threadEvents()).length === 1);
    const completed = threadEvents().find(
      (event) =>
        event.type === "item/completed" && event.item.type === "toolCall",
    );
    expect(completed).toMatchObject({
      item: { server: "bb", tool: "lookup", result: "42", status: "completed" },
    });
    expect(replies(threadEvents())).toEqual(["Tool called: lookup"]);
  });

  it("reports provider death, failed and stalled turns", async () => {
    const timing = { turnStartTimeoutMs: 30, watchdogIntervalMs: 10 };
    const { api, threadEvents, dataDir } = await setup(timing);
    await api.submitTurn(turn("crash"));
    const exited = await until(() =>
      threadEvents().find((event) => event.type === "system/error"),
    );
    const failed = completions(threadEvents())[0];
    expect(failed).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("exited unexpectedly") },
    });
    expect(exited).toMatchObject({
      code: "provider_process_exited",
      detail: "stderr:\nscripted crash",
      scope: failed.scope,
    });
    expect((await api.snapshot()).sessions).toEqual([]);

    await api.submitTurn(turn("fail_turn:quota_exhausted"));
    await until(() => completions(threadEvents()).length === 2);
    const error = threadEvents().find(
      (event) => event.type === "provider/error",
    );
    expect(error).toMatchObject({
      detail: "quota exhausted",
      willRetry: false,
    });
    expect(completions(threadEvents())[1]).toMatchObject({ status: "failed" });

    await api.submitTurn(turn("swallow_turn"));
    await expectCode(api.submitTurn(turn("second")), "competing_turn");
    const stalled = await until(() =>
      threadEvents().find(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_timeout",
      ),
    );
    expect(stalled.scope).toEqual({ kind: "thread" });

    const storage = join(dataDir, "thread-storage", THREAD);
    expect(existsSync(join(storage, "echo-state.json"))).toBe(true);
    await api.deleteThreadStorage({ threadId: THREAD });
    expect(existsSync(storage)).toBe(false);
    expect((await api.snapshot()).sessions).toEqual([]);
    await expectCode(
      api.deleteThreadStorage({ threadId: "../x" }),
      "invalid_path",
    );
  });

  it("describes the runner and its providers", async () => {
    const { api, dataDir } = await setup();
    const info = await api.describe();
    expect(info).toMatchObject({
      dataDir,
      threadStorageRoot: join(dataDir, "thread-storage"),
    });
    expect(info.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await api.listProviders()).toMatchObject([
      { providerId: "echo", installed: true, auth: "ready" },
    ]);
    const { models } = await api.listModels({ providerId: "echo", cwd: null });
    expect(models.map((model) => [model.id, model.isDefault])).toEqual([
      ["echo-1", true],
      ["echo-2", false],
    ]);
    const unknown = api.listModels({ providerId: "codex", cwd: null });
    await expectCode(unknown, "unavailable");
  });
});
