// Records raw `claude` stdio traffic by driving the real TypeScript runner.
// Run from the repo root:
//   node --conditions=source --import tsx crates/bb-claude/tests/fixtures/raw/record.ts <scenario>
// Each scenario runs real Claude Code sessions on the current login.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeClientTurnRequestIdNumber } from "../../../../../packages/domain/src/index.ts";
import { createLocalRunner } from "../../../../../packages/runner/src/index.ts";
import type {
  ExecutionOptions,
  RunnerEvent,
  SubmitTurnArgs,
} from "../../../../../packages/runner/src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");
const POINTER = "/tmp/bb-claude-rec/current";
const MODEL = "claude-haiku-4-5";
const SECOND_MODEL = "claude-sonnet-4-6";
const LOOKUP = {
  name: "lookup",
  description: "Look up a value",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
};
const BASE: ExecutionOptions = {
  model: MODEL,
  reasoningLevel: "low",
  serviceTier: "default",
  permissionMode: "accept-edits",
  permissionEscalation: "ask",
  providerOptions: {},
};

type Policy = { approval: "allow" | "deny" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(probe: () => T | undefined | false, ms = 120_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(50);
  }
}

async function session(scenario: string, policy: Policy = { approval: "allow" }) {
  const out = join(HERE, scenario);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await mkdir(dirname(POINTER), { recursive: true });
  await writeFile(POINTER, `${out}\n`);
  process.env.BB_CLAUDE_CODE_EXECUTABLE = join(HERE, "claude-recorder");
  const dataDir = await mkdtemp(join(tmpdir(), "bb-claude-rec-data-"));
  const cwd = await mkdtemp(join(tmpdir(), "bb-claude-rec-cwd-"));
  await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\n");
  const events: RunnerEvent[] = [];
  const runner = createLocalRunner({
    dataDir,
    serverUrl: "http://127.0.0.1:9",
    bbCliPath: join(ROOT, "apps/cli/bin/bb"),
    sink: (event) => {
      events.push(event);
      void react(event).catch((error) => console.error("react failed", error));
    },
  });
  const threadId = `thr_rec_${scenario.replace(/-/g, "_")}`;
  let counter = 0;
  let providerThreadId: string | null = null;
  let dynamicTools: (typeof LOOKUP)[] = [];

  async function react(event: RunnerEvent) {
    if (event.kind === "interaction.requested") {
      const { payload, requestId } = event;
      console.error("interaction", JSON.stringify(payload).slice(0, 400));
      if (payload.kind === "user_question") {
        const answers = Object.fromEntries(
          payload.questions.map((q) => [
            q.id,
            { selected: [String(q.options?.[0]?.value)] },
          ]),
        );
        const resolution = { kind: "user_answer" as const, answers };
        await runner.resolveInteraction({ threadId, requestId, resolution });
        return;
      }
      const resolution =
        policy.approval === "allow"
          ? { decision: "allow_once" as const, grantedPermissions: null }
          : { decision: "deny" as const };
      await runner.resolveInteraction({ threadId, requestId, resolution });
    }
    if (event.kind === "toolCall.requested") {
      console.error("toolCall", event.tool, JSON.stringify(event.arguments));
      const contentItems = [{ type: "inputText" as const, text: "value-of-a=42" }];
      const result = { success: true, contentItems };
      await runner.resolveToolCall({ threadId, requestId: event.requestId, result });
    }
  }

  const types = () =>
    events.flatMap((e) =>
      e.kind === "thread.events" ? e.events.map((x) => x.type) : [],
    );
  const completedCount = () =>
    types().filter((t) => t === "turn/completed").length;

  function args(
    text: string,
    options = BASE,
    mode: SubmitTurnArgs["mode"] = { kind: "start" },
  ): SubmitTurnArgs {
    counter += 1;
    const clientRequestId = encodeClientTurnRequestIdNumber({ value: counter });
    return {
      session: {
        threadId,
        providerId: "claude-code",
        cwd,
        providerThreadId,
        instructions: "You are being recorded for a protocol test. Be brief.",
        dynamicTools,
        env: { BB_THREAD_ID: threadId },
        skillDirs: [],
      },
      clientRequestId,
      input: [{ type: "text", text, mentions: [] }],
      options,
      mode,
    };
  }

  async function turn(text: string, options = BASE) {
    const before = completedCount();
    const started = await runner.submitTurn(args(text, options));
    providerThreadId = started.providerThreadId;
    await until(() => completedCount() > before);
  }

  // Polls the wrapper's recording for streamed text from the CLI.
  let cache = "";
  async function waitForTextDelta(skip: number) {
    const file = join(out, "interleaved.ndjson");
    return until(() => {
      void readFile(file, "utf8").then((text) => (cache = text), () => {});
      const deltas = cache
        .split("\n")
        .filter((l) => l.includes('"text_delta"') && l.includes('"dir":"out"'));
      return deltas.length > skip;
    });
  }

  async function finish() {
    await runner.releaseSession({ threadId }).catch((e) => console.error(e));
    await sleep(1500);
    await runner.shutdown().catch(() => undefined);
    await writeFile(join(out, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
    await writeFile(
      join(out, "meta.json"),
      `${JSON.stringify({ scenario, threadId, providerThreadId, cwd, model: MODEL }, null, 2)}\n`,
    );
    await rm(dataDir, { recursive: true, force: true });
  }

  return {
    runner,
    threadId,
    events,
    turn,
    args,
    finish,
    waitForTextDelta,

    completedCount,
    setResume: (id: string) => (providerThreadId = id),
    setTools: (tools: (typeof LOOKUP)[]) => (dynamicTools = tools),
  };
}

const scenarios: Record<string, () => Promise<void>> = {
  async simple() {
    const s = await session("simple");
    await s.turn("Reply with exactly: ok");
    await s.finish();
  },
  async "approval-allow"() {
    const s = await session("approval-allow", { approval: "allow" });
    await s.turn(
      "Use the Bash tool to run: python3 -c 'print(1+1)'. Then reply with its output.",
    );
    await s.finish();
  },
  async "approval-deny"() {
    const s = await session("approval-deny", { approval: "deny" });
    await s.turn(
      "Use the Bash tool to run: python3 -c 'print(1+1)'. If it is denied, reply: denied.",
    );
    await s.finish();
  },
  async "dynamic-tool"() {
    const s = await session("dynamic-tool");
    s.setTools([LOOKUP]);
    await s.turn('Call the lookup tool with key "a", then reply with the result.');
    await s.finish();
  },
  async interrupt() {
    const s = await session("interrupt");
    const before = s.completedCount();
    await s.runner.submitTurn(
      s.args("Without using any tools, write a 600-word story about a lighthouse keeper."),
    );
    await s.waitForTextDelta(0);
    await sleep(1000);
    console.error("interrupting", await s.runner.interruptTurn({ threadId: s.threadId }));
    await until(() => s.completedCount() > before);
    await sleep(500);
    await s.turn("Reply with exactly: second");
    await s.finish();
  },
  async resume() {
    const meta = JSON.parse(await readFile(join(HERE, "simple", "meta.json"), "utf8"));
    const s = await session("resume");
    s.setResume(meta.providerThreadId);
    await s.turn("What did I ask you to reply with before? Answer in three words or fewer.");
    await s.finish();
  },
  async steer() {
    const s = await session("steer");
    const before = s.completedCount();
    const started = await s.runner.submitTurn(
      s.args("Without using any tools, write a 600-word story about a lighthouse keeper."),
    );
    await s.waitForTextDelta(0);
    const snap = await s.runner.snapshot();
    const turnId = snap.sessions.find((x) => x.threadId === s.threadId)?.activeTurnId;
    console.error("steering turn", turnId, started);
    const steered = await s.runner.submitTurn(
      s.args("Stop counting now and reply with exactly: steered", BASE, {
        kind: "steer",
        expectedTurnId: String(turnId),
      }),
    );
    console.error("steer result", steered);
    await until(() => s.completedCount() > before);
    await sleep(3000);
    await s.finish();
  },
  async "settings-change"() {
    const s = await session("settings-change");
    await s.turn("Reply with exactly: one");
    await s.turn("Reply with exactly: two", {
      ...BASE,
      model: SECOND_MODEL,
      reasoningLevel: "high",
    });
    // A permissionMode change alters the adapter's session signature and
    // respawns the CLI with --resume; it was left out to stay within the
    // session budget (see PROTOCOL.md).
    await s.finish();
  },
  async "user-question"() {
    const s = await session("user-question");
    await s.turn(
      "Use your AskUserQuestion tool to ask me one question: red or blue (two options). Then reply with my choice.",
    );
    await s.finish();
  },
};

const name = process.argv[2] ?? "";
const run = scenarios[name];
if (!run) {
  console.error(`usage: record.ts <${Object.keys(scenarios).join("|")}>`);
  process.exit(2);
}
const watchdog = setTimeout(() => {
  console.error("scenario timed out");
  process.exit(1);
}, 240_000);
await run();
clearTimeout(watchdog);
process.exit(0);
