import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadEventItemPresentationSchema as presentationSchema } from "@bb/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import * as claude from "./claude-replay.js";
import { settle } from "./kit.js";

const SCENARIOS = `turn-tools:2 steer-compaction:4 stop-interrupt:4
  approval-allow:4 approval-deny:4 subagent:2 resume:4 web-search:2
  plan-mode:7 user-question:4 auth-failure:2`.split(/\s+/);
const session_id = "sess-1";
const reason = { decisionReason: "Needs approval" };
const once = { decision: "allow_once" as const, grantedPermissions: null };

function assistant(...content: object[]) {
  const message = { role: "assistant", content, usage: { input_tokens: 5 } };
  return { type: "assistant", message, parent_tool_use_id: null, session_id };
}

function toolUse(id: string, name: string, input: object) {
  return { type: "tool_use", id, name, input };
}

function toolResult(id: string, content: unknown, extra: object = {}) {
  const is_error = "failed" in extra;
  const block = { type: "tool_result", tool_use_id: id, content, is_error };
  const message = { role: "user", content: [block] };
  return { type: "user", message, session_id, ...extra };
}

function items(harness: claude.ClaudeHarness, type = "item/started") {
  return harness.events.flatMap((event) => {
    if (event.type !== type || !("item" in event)) return [];
    const item: Record<string, unknown> = { ...event.item };
    const shown = presentationSchema.optional().parse(item.presentation);
    const { label, icon, title, detail, suppress, badge } = shown ?? {};
    const flags = [suppress && "hidden", badge?.label];
    const parts = [item.type, label?.pending, icon?.glyph, title, detail];
    const brief = [...parts, ...flags].filter(Boolean).join(" | ");
    return [Object.assign(item, { brief })];
  });
}

describe("claude adapter", () => {
  it.each(SCENARIOS)("replays %s like the original pipeline", async (entry) => {
    const [scenario = "", checks] = entry.split(":");
    const replay = await claude.replayClaudeRecording(scenario);
    expect(replay.events).toEqual(replay.original);
    expect(replay.mismatches).toEqual([]);
    expect(replay.checked).toHaveLength(Number(checks));
  });

  it("labels escaped commands and bb tools, and serves bb tools", async () => {
    const harness = claude.createClaudeHarness();
    const label = { pending: "Nooping", completed: "Nooped" };
    const presentation = { label, icon: { glyph: "Zap" } };
    const inputSchema = { type: "object", properties: {} };
    const noop = { name: "noop", description: "Nothing", inputSchema };
    const dynamicTools = [{ ...noop, presentation }];
    const live = await harness.open({ dynamicTools });
    await live.turn("go");
    const escape = { run_in_background: true, dangerouslyDisableSandbox: true };
    const agent = { description: "Dig", subagent_type: "Explore" };
    const report = "agentId: 7\nFound it\n<usage>1</usage>";
    live.query.emit(
      assistant(
        toolUse("t1", "Bash", { command: "ls\npwd", ...escape }),
        toolUse("t2", "Task", agent),
        toolUse("t3", "mcp__github__create_issue", { title: "x" }),
        toolUse("t4", "mcp__bb-bridge__noop", {}),
      ),
      toolResult("t2", [{ type: "text", text: report }]),
    );
    await settle();
    const started = items(harness);
    expect(started.map((item) => item.brief)).toEqual([
      "commandExecution | Starting background command | Terminal | ls | Outside of sandbox",
      "delegation | Running subagent | UserRound | Dig | Explore agent",
      "toolCall | Running create_issue | Toolbox | github",
      "toolCall | Nooping | Zap",
    ]);
    expect(started[2]).toMatchObject({ server: "github", arguments: {} });
    const [delegation] = items(harness, "item/completed");
    expect(delegation).toMatchObject({ summary: "Found it" });
    const { mcpServers, allowedTools } = live.query.args.options;
    expect(allowedTools).toEqual(["mcp__bb-bridge__noop"]);
    const server = mcpServers?.["bb-bridge"];
    if (server?.type !== "sdk")
      throw new Error("expected an in-process server");
    const [near, far] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.instance.connect(far), client.connect(near)]);
    const listed = await client.listTools();
    expect(listed.tools).toMatchObject([{ name: "noop", inputSchema }]);
    const _meta = { "claudecode/toolUseId": "t4" };
    const result = await client.callTool({ name: "noop", _meta });
    expect(result.content).toEqual([{ type: "text", text: "moved" }]);
    const turnId = live.builder.activeTurnId;
    const callId = live.builder.bbItemId("t4");
    const forwarded = { tool: "noop", arguments: {}, turnId, callId };
    expect(harness.toolCalls).toEqual([forwarded]);
  });

  it("folds task tools into plan steps and tracks background tasks", async () => {
    const harness = claude.createClaudeHarness();
    const live = await harness.open({ dynamicTools: [] });
    await live.turn("go");
    const create = { subject: "Write tests", activeForm: "Writing tests" };
    const created = { task: { id: "1", subject: "Write tests" } };
    const update = { taskId: "1", status: "in_progress" };
    const updated = { success: true, taskId: "1" };
    const background = { command: "sleep 9", run_in_background: true };
    const task = { type: "system", task_id: "b1", session_id };
    const watch = { task_type: "local_bash", description: "Watch" };
    const outcome = { status: "completed", summary: "exit 0" };
    live.query.emit(
      assistant(toolUse("t1", "TaskCreate", create)),
      toolResult("t1", "ok", { tool_use_result: created }),
      assistant(toolUse("t2", "TaskUpdate", update)),
      toolResult("t2", "ok", { tool_use_result: updated }),
      assistant(toolUse("t3", "Bash", background)),
      { ...task, subtype: "task_started", tool_use_id: "t3", ...watch },
      { type: "result", subtype: "success", is_error: false, session_id },
    );
    await settle();
    expect(live.builder.hasOpenBackgroundWork()).toBe(true);
    const notified = { subtype: "task_notification", output_file: "/o" };
    live.query.emit({ ...task, ...notified, ...outcome });
    await settle();
    expect(live.builder.hasOpenBackgroundWork()).toBe(false);
    const completed = items(harness, "item/completed");
    const plans = completed.filter((item) => item.type === "planSteps");
    const steps = plans.map((plan) => plan.steps);
    const pending = [{ step: "Write tests", status: "pending" }];
    const active = [{ step: "Writing tests", status: "active" }];
    expect(steps).toEqual([pending, active]);
    const plan =
      "planSteps | Updating plan | ListTodo | Writing tests | hidden";
    expect(plans[1]?.brief).toBe(plan);
    const [closed, late] = harness.events.slice(-2);
    expect(closed?.type).toBe("turn/completed");
    expect(late).toMatchObject({ scope: { kind: "thread" } });
    const [finished] = items(harness, "item/backgroundTask/completed");
    const ended = { ...outcome, taskStatus: "completed", outputFile: "/o" };
    expect(finished).toMatchObject({ familyId: "b1", ...ended });
    const row =
      "backgroundTask | Running background command | Terminal | Watch";
    expect(finished?.brief).toBe(row);
  });

  it("asks for approval and maps each decision back", async () => {
    const harness = claude.createClaudeHarness();
    const live = await harness.open();
    await live.turn("go");
    const command = { command: "curl example.com" };
    const allowed = { behavior: "allow", updatedInput: command };
    expect(await live.decide("Bash", command)).toMatchObject(allowed);
    const temporary = live.decide("Bash", command, reason);
    await settle();
    const asked = harness.interactions.shift();
    const shell = { kind: "command", itemId: "toolu_ask", ...command };
    expect(asked?.turnId).toBe(live.builder.activeTurnId);
    expect(asked?.payload).toMatchObject({
      kind: "approval",
      reason: "Needs approval",
      subject: { ...shell, cwd: null },
      availableDecisions: ["allow_once", "deny"],
    });
    asked?.resolve(once);
    const kind = { decisionClassification: "user_temporary" };
    expect(await temporary).toMatchObject({ ...allowed, ...kind });
    const write = { file_path: "/outside/a.txt", content: "x" };
    const lasting = live.decide("Write", write, { blockedPath: "/outside" });
    await settle();
    const fileSystem = { read: [], write: ["/outside"] };
    const grantedPermissions = { network: null, fileSystem };
    const subject = { kind: "file_change", sessionGrant: grantedPermissions };
    const availableDecisions = ["allow_once", "allow_for_session", "deny"];
    const request = { subject, availableDecisions };
    expect(harness.interactions[0]?.payload).toMatchObject(request);
    const decision = "allow_for_session" as const;
    harness.interactions.shift()?.resolve({ decision, grantedPermissions });
    const update = { type: "addDirectories", directories: ["/outside"] };
    const updatedPermissions = [{ ...update, destination: "session" }];
    const permanent = { decisionClassification: "user_permanent" };
    expect(await lasting).toMatchObject({ ...permanent, updatedPermissions });
    const fetch = live.decide("WebFetch", { url: "https://x.dev" }, reason);
    await settle();
    const permissions = { network: { enabled: true }, fileSystem: null };
    const web = { kind: "permission_grant", toolName: "WebFetch", permissions };
    expect(harness.interactions[0]?.payload).toMatchObject({ subject: web });
    harness.interactions.shift()?.resolve({ decision: "deny" });
    const denied = { behavior: "deny", message: "Permission request denied" };
    expect(await fetch).toMatchObject(denied);
    const plan = { plan: "1. Ship", planFilePath: "/plans/p.md" };
    const rejected = live.decide("ExitPlanMode", plan);
    await settle();
    harness.interactions.shift()?.resolve({ decision: "deny" });
    const rejection = expect.stringContaining("rejected this plan");
    expect(await rejected).toMatchObject({ message: rejection });
    const pending = live.decide("Bash", command, reason);
    await settle();
    const before = harness.events.length;
    await live.session.interrupt();
    harness.interactions.length = 0;
    expect(await pending).toMatchObject({ behavior: "deny", interrupt: true });
    expect(harness.events.at(-1)).toMatchObject({ status: "interrupted" });
    const failed = { subtype: "error_during_execution", is_error: true };
    live.query.emit({ type: "result", ...failed, session_id });
    await settle();
    expect(harness.events).toHaveLength(before + 1);
    expect(live.query.calls).toEqual([["interrupt"]]);
    expect(live.session.canApply(claude.SPEC, claude.OPTIONS)).toBe(false);
    const unattended = await harness.open({}, { permissionEscalation: "deny" });
    const refused = await unattended.decide("Bash", command, reason);
    expect(refused).toMatchObject({ message: "Needs approval" });
    const full = await harness.open({}, { permissionMode: "full" });
    expect(await full.decide("Bash", command, reason)).toMatchObject(allowed);
    expect(harness.interactions).toHaveLength(0);
  });

  it("turns user answers into the tool input", async () => {
    const harness = claude.createClaudeHarness();
    const live = await harness.open();
    const options = ["Red", "Blue"].map((label) => ({
      label,
      description: label,
    }));
    const colour = { question: "Colour?", header: "Tint", multiSelect: true };
    const questions = [{ ...colour, options }];
    const asking = live.decide("AskUserQuestion", { questions });
    await settle();
    const id = "toolu_ask:question-1";
    const selected = [`${id}:option-1`, `${id}:option-2`];
    const answers = { [id]: { selected, freeText: "but dark" } };
    harness.interactions.shift()?.resolve({ kind: "user_answer", answers });
    const annotations = { "Colour?": { notes: "but dark" } };
    const answered = { answers: { "Colour?": "Red, Blue; but dark" } };
    const updatedInput = { questions, ...answered, annotations };
    expect(await asking).toMatchObject({ behavior: "allow", updatedInput });
    const invalid = await live.decide("AskUserQuestion", { questions: [] });
    expect(invalid).toMatchObject({ behavior: "deny" });
  });

  it("builds the query from the spec and applies later changes live", async () => {
    const harness = claude.createClaudeHarness();
    const skills = await mkdtemp(join(tmpdir(), "bb-claude-skills-"));
    const env = { BB_THREAD_ID: "thr_1", ANTHROPIC_BASE_URL: "http://pool" };
    const processEnv = { HOME: "/home/u", CLAUDE_AGENT_SDK_CLIENT_APP: "x" };
    const resumed = { providerThreadId: "sess-0", instructions: "Be brief." };
    const spec = { ...resumed, skillDirs: [skills] };
    const start = { model: "opus[1m]", reasoningLevel: "ultracode" as const };
    const live = await harness.open(spec, start, { env, processEnv });
    const { options } = live.query.args;
    const flags = { autoMemoryEnabled: true, enableWorkflows: true };
    expect(options).toMatchObject({
      resume: "sess-0",
      model: "opus[1m]",
      permissionMode: "acceptEdits",
      effort: "xhigh",
      systemPrompt: { preset: "claude_code", append: "Be brief." },
      settings: { ...flags, ultracode: true, fastMode: false },
      sandbox: { enabled: true },
      env: { ...env, HOME: "/home/u", CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    expect(options.env).not.toHaveProperty("CLAUDE_AGENT_SDK_CLIENT_APP");
    const plugin = join(options.plugins?.[0]?.path ?? "", ".claude-plugin");
    const manifest = await readFile(join(plugin, "plugin.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ name: "bb-global-skills" });
    const changes = { model: "sonnet", serviceTier: "fast" as const };
    await live.turn("think", { ...changes, planMode: true });
    const fast = { ...flags, effortLevel: "xhigh", ultracode: true };
    const settings = ["flags", { ...fast, fastMode: true }];
    const calls = [["model", "sonnet"], settings, ["mode", "plan"]];
    expect(live.query.calls).toEqual(calls);
    const same = { ...claude.SPEC, ...spec };
    const next = { ...claude.OPTIONS, ...start, ...changes };
    expect(live.session.canApply(same, next)).toBe(true);
    expect(live.session.canApply({ ...same, cwd: "/b" }, next)).toBe(false);
  });
});
