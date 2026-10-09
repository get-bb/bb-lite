import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { parsed, startBb } from "./helpers.js";

interface Thread {
  id: string;
}
interface Shown {
  thread: Thread;
  environment: { id: string; hostId: string };
}
interface Failure {
  ok: false;
  error: { code: string; message: string; hint?: string };
}
type Event = { seq: number; type: string; threadId: string };

const SLOW = 120_000;
const ECHO_PLUGIN = fileURLToPath(
  new URL("../../server/test/fixtures/echo-plugin", import.meta.url),
);

it(
  "runs the canonical agent recipes against the echo provider",
  async () => {
    const { bb, project, ctx } = await startBb();
    const spawn = ["thread", "spawn", "--project", project.id];
    const echo = ["--provider", "echo"];
    const first = [...spawn, ...echo, "--prompt", "parent ready", "--json"];
    const parent = parsed<Thread>(await bb(first));
    const idle = ["--status", "idle", "--timeout", "30s"];
    const pace = ["--poll-interval", "100ms", "--json"];
    const waited = await bb(["thread", "wait", parent.id, ...idle, ...pace]);
    const target = { kind: "status", status: "idle" };
    const matched = { threadId: parent.id, matched: true, target };
    expect([waited.code, parsed(waited)]).toEqual([0, matched]);
    const shown = await bb(["thread", "show", parent.id, "--json"]);
    const { environment } = parsed<Shown>(shown);
    expect(environment.hostId).toBe(ctx.config.hostId);

    const self = { BB_THREAD_ID: parent.id, BB_ENVIRONMENT_ID: environment.id };
    const place = ["--parent-self", "--environment", environment.id];
    const brief = ["--title", "child", "--prompt-file", "-"];
    const worker = [...spawn, ...place, ...echo, ...brief];
    const spawned = await bb(worker, self, "hold_turn child task\n");
    const notice = "You will be notified when this thread is done.";
    expect(spawned.stdout).toContain(notice);
    const [, child = ""] =
      /Thread spawned: (thr_\w+)/u.exec(spawned.stdout) ?? [];
    const drained = { timeout: 30_000, interval: 250 };
    const turn = "SELECT active_turn_id FROM threads WHERE id = ?";
    const started = (): unknown => ctx.db.get(turn, child);
    const running = { activeTurnId: expect.any(String) };
    await vi.waitFor(() => expect(started()).toEqual(running), drained);

    const tell = ["thread", "tell", child];
    const later = await bb(
      [...tell, "queued note", "--mode", "queue", "--json"],
      self,
    );
    const queuedMessage = { threadId: child, senderThreadId: parent.id };
    const queued = { threadId: child, delivery: "queued", mode: "queue" };
    expect(parsed(later)).toMatchObject({ ...queued, queuedMessage });
    const steer = [...tell, "--message-file", "-", "--mode", "steer", "--json"];
    const steered = await bb(steer, self, "finish release_turn");
    const sent = { threadId: child, delivery: "sent", mode: "steer" };
    expect(parsed(steered)).toMatchObject(sent);

    const output = async (): Promise<string> =>
      (await bb(["thread", "output", child])).stdout;
    await vi.waitFor(
      async () => expect(await output()).toContain("queued note"),
      drained,
    );
    const settled = await bb(["thread", "wait", child, "--timeout", "30"]);
    expect(settled.stdout).toBe(`Thread ${child} reached status idle.\n`);
    const result = parsed<{ output: string }>(
      await bb(["thread", "output", child, "--json"]),
    );
    expect(result.output).toContain(`[bb message from thread:${parent.id}]`);

    const log = parsed<Event[]>(await bb(["thread", "log", child, "--json"]));
    const types = log.map((event) => event.type);
    const turnEvents = ["client/turn/requested", "turn/completed"];
    expect(types).toEqual(expect.arrayContaining(turnEvents));
    const sequences = log.map((event) => event.seq);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    const family = ["--parent-thread", parent.id, "--include-hidden", "--json"];
    const children = parsed<Thread[]>(await bb(["thread", "list", ...family]));
    expect(children.map((thread) => thread.id)).toEqual([child]);
    const host = ctx.db.get<{ name: string }>("SELECT name FROM hosts");
    const fresh = [
      "--machine",
      host?.name ?? "",
      "--new-environment",
      "worktree",
    ];
    const branch = ["--base-branch", "origin/main", "--prompt", "x", "--json"];
    const isolated = await bb([...spawn, ...echo, ...fresh, ...branch]);
    const accepted = { projectId: project.id, parentThreadId: null };
    expect(parsed(isolated)).toMatchObject(accepted);
    const archive = ["thread", "archive", "--self", "--json"];
    const archived = await bb(archive, { BB_THREAD_ID: child });
    const gone = { ok: true, threadId: child, archivedThreadIds: [child] };
    expect(parsed(archived)).toEqual(gone);
    const restore = ["thread", "unarchive", child, "--json"];
    const restored = await bb(restore);
    expect(parsed(restored)).toEqual({ ok: true, threadId: child });
  },
  SLOW,
);

it(
  "reports failures as a JSON envelope with the documented exit codes",
  async () => {
    const { bb, project } = await startBb();
    const missing = await bb(["thread", "tell", "thr_missing", "hi", "--json"]);
    const message = expect.stringContaining("Thread not found");
    const error = { code: "thread_not_found", message };
    expect(parsed(missing)).toEqual({ ok: false, error });
    expect([missing.code, missing.stderr]).toEqual([
      1,
      expect.stringMatching(/^Error: .*Thread not found/u),
    ]);

    const spawn = ["thread", "spawn", "--project", project.id, "--json"];
    const hold = [...spawn, "--provider", "echo", "--prompt", "hold_turn"];
    const held = parsed<Thread>(await bb(hold));
    const wait = ["thread", "wait", held.id];
    const timedOut = await bb([...wait, "--timeout", "1", "--json"]);
    const timeout = parsed<Failure>(timedOut).error.code;
    expect([timedOut.code, timeout]).toEqual([2, "timeout"]);
    const invalid = await bb([...wait, "--status", "bogus", "--json"]);
    expect([invalid.code, parsed<Failure>(invalid).ok]).toEqual([3, false]);
    const both = [...wait, "--status", "idle", "--event", "turn/completed"];
    expect((await bb(both)).code).toBe(3);

    const noSelf = await bb(["thread", "archive", "--self", "--json"]);
    const needsThread = "--self requires BB_THREAD_ID to be set.";
    expect(parsed<Failure>(noSelf).error.message).toBe(needsThread);
    const typo = await bb(["thread", "spawn", "--promt", "x", "--json"]);
    const suggestion = "Unknown option --promt. Did you mean '--prompt'?";
    const unknownOption = { code: "unknown_option", message: suggestion };
    expect(parsed<Failure>(typo).error).toMatchObject(unknownOption);
    const unconfirmed = await bb(["thread", "delete", held.id]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("Re-run with --yes to confirm.");
    const stopped = await bb(["thread", "stop", held.id]);
    expect(stopped.stdout).toBe(`Thread ${held.id} stopped\n`);
  },
  SLOW,
);

it(
  "dispatches plugin commands to the server and returns their exit code",
  async () => {
    const { bb } = await startBb();
    const added = await bb(["plugin", "add", ECHO_PLUGIN, "--json"]);
    const { plugins } = parsed<{ plugins: Thread[] }>(added);
    expect(plugins.map((plugin) => plugin.id)).toContain("echo");
    const loud = ["echo", "say", "hi", "--times", "2", "--tone-stdin"];
    expect(await bb(loud, {}, "loud\n")).toMatchObject({
      code: 0,
      stdout: "HI HI\n",
    });
    const caller = { BB_THREAD_ID: "thr_caller" };
    const scoped = await bb(["echo", "say", "hi", "--json"], caller);
    expect(parsed(scoped)).toEqual({ said: "hi", threadId: "thr_caller" });
    const refused = await bb(["echo", "say", "nothing"]);
    expect(refused).toMatchObject({ code: 3, stderr: "Nothing to say\n" });
    const unknown = await bb(["nonsense", "--json"]);
    expect(parsed<Failure>(unknown).error.code).toBe("unknown_command");
  },
  SLOW,
);

it(
  "says a queue is paused by a manual stop and how to resume it",
  async () => {
    const { bb, project, ctx } = await startBb();
    const spawn = ["thread", "spawn", "--project", project.id];
    const first = [...spawn, "--provider", "echo", "--prompt", "hold_turn"];
    const thread = parsed<Thread>(await bb([...first, "--json"]));
    const turn = "SELECT active_turn_id FROM threads WHERE id = ?";
    const running = { activeTurnId: expect.any(String) };
    const drained = { timeout: 30_000, interval: 250 };
    await vi.waitFor(
      () => expect(ctx.db.get(turn, thread.id)).toEqual(running),
      drained,
    );
    await bb(["thread", "tell", thread.id, "later", "--mode", "queue"]);
    await bb(["thread", "stop", thread.id]);
    await bb(["thread", "wait", thread.id, "--timeout", "30"]);
    const listed = await bb(["thread", "queue", "list", thread.id]);
    expect(listed.stdout).toContain("paused by a manual stop");
    expect(listed.stdout).toContain("`bb thread queue send` resumes");
  },
  SLOW,
);

it(
  "retries the failed turn of a thread and refuses one that did not fail",
  async () => {
    const { bb, project, ctx } = await startBb();
    const spawn = ["thread", "spawn", "--project", project.id];
    const prompt = ["--provider", "echo", "--prompt", "oops fail_turn:boom"];
    const thread = parsed<Thread>(await bb([...spawn, ...prompt, "--json"]));
    const failed = ["--status", "error", "--timeout", "30s"];
    await bb(["thread", "wait", thread.id, ...failed]);
    const retried = await bb(["thread", "retry", thread.id, "--json"]);
    const sent = { threadId: thread.id, ok: true, delivery: "sent" };
    expect([retried.code, parsed(retried)]).toEqual([0, sent]);
    const turns =
      "SELECT count(*) AS n FROM events WHERE thread_id = ? AND type = 'client/turn/requested'";
    const drained = { timeout: 30_000, interval: 250 };
    await vi.waitFor(
      () => expect(ctx.db.get(turns, thread.id)).toEqual({ n: 2 }),
      drained,
    );
    await bb(["thread", "wait", thread.id, ...failed]);
    await bb(["thread", "tell", thread.id, "fine now"]);
    await bb(["thread", "wait", thread.id, "--timeout", "30"]);
    const refused = await bb(["thread", "retry", thread.id, "--json"]);
    expect(refused.code).not.toBe(0);
    const error = parsed<Failure>(refused).error;
    expect(error).toMatchObject({ code: "conflict" });
  },
  SLOW,
);
