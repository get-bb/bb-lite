// Writes the fixtures of tests/operation_projection.rs: hand-written lifecycle scenarios and the
// recorded parity thread event streams, each projected by the TypeScript buildEventProjection.
// Run from packages/thread-view (for its node_modules):
//   node --conditions=source --import tsx ../../crates/bb-thread-view/tests/fixtures/operation_projection/generate.ts
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { buildEventProjection } from "../../../../../packages/thread-view/src/build-event-projection.ts";

const OUT = import.meta.dirname;
const PARITY = `${OUT}/../../../../bb-server/tests/fixtures/parity/threads`;
const T = "thr_ops";
const OPTIONS = [
  { includeDiagnosticOperations: false, threadStatus: "idle", threadName: "Fixture thread" },
  { includeDiagnosticOperations: false, threadStatus: "error", threadName: "Fixture thread" },
  { includeDiagnosticOperations: true, threadStatus: "active", threadName: "Fixture thread" },
];
const turn = (id: string) => ({ kind: "turn", turnId: id });
const thread = { kind: "thread" };
function seqd(events: any[]) {
  return events.map((event, i) => ({
    event: { threadId: T, ...event },
    meta: { id: `evt_${i + 1}`, seq: i + 1, createdAt: 1790000000000 + (i + 1) * 1000 },
  }));
}
const started = (t: string) => ({ type: "turn/started", scope: turn(t), providerThreadId: "p1" });
const completed = (t: string, status = "completed", error?: any) => ({
  type: "turn/completed", scope: turn(t), providerThreadId: "p1", status, ...(error ? { error } : {}),
});
const prov = (status: string, entries: any[], id = "tpv_1") => ({
  type: "system/thread-provisioning", scope: thread, provisioningId: id, environmentId: null, status, entries,
});
const step = (key: string, status: string, text: string) => ({ type: "step", key, status, text, startedAt: 1790000000000 });
const inter = (t: string, id: string, status: string, payload: any, resolution: any = null, origin: any = { kind: "provider", providerId: "echo", providerRequestId: "r1" }, statusReason: any = null) => ({
  type: "system/interaction/lifecycle", scope: turn(t),
  interaction: { id, origin, payload, resolution, status, statusReason },
});
const grant = { kind: "approval", reason: "needs write", subject: { kind: "permission_grant", itemId: "item_g", toolName: "Write", permissions: { fileSystem: { write: ["/tmp"] } }, actions: [] } };
const question = { kind: "user_question", questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };
const plugin = { kind: "plugin", title: "Pick a color", presentation: { kind: "form" } };
const pluginOrigin = { kind: "plugin", pluginId: "acme", rendererId: "color-form" };
const fc = (type: string, t: string, id: string, status: string, changes: any[], extra: any = {}) => ({
  type, scope: turn(t), providerThreadId: "p1", item: { type: "fileChange", id, status, changes, ...extra },
});
const fcOut = (t: string, id: string, delta: string) => ({ type: "item/fileChange/outputDelta", scope: turn(t), providerThreadId: "p1", itemId: id, delta });
const comp = (type: string, t: string, id: string, status = "completed") => ({
  type, scope: turn(t), providerThreadId: "p1", item: { type: "contextCompaction", id, status },
});

const scenarios: Record<string, any[]> = {
  provisioning: [
    prov("active", [step("workspace-started", "started", "Preparing workspace")]),
    prov("active", [step("workspace-started", "completed", "Workspace ready"), step("setup", "started", "Running setup")]),
    prov("failed", [step("setup", "failed", "Setup failed")]),
    prov("completed", [step("late", "completed", "Late step")]),
    prov("active", [step("other", "started", "Second provisioning")], "tpv_2"),
  ],
  interruption: [
    started("t1"),
    prov("active", [step("a", "started", "A")]),
    { type: "system/thread/interrupted", scope: thread, reason: "manual-stop" },
    completed("t1", "interrupted"),
  ],
  approvals: [
    started("t1"),
    inter("t1", "pint_a", "pending", grant),
    inter("t1", "pint_a", "resolving", grant, { decision: "allow_once", grantedPermissions: null }),
    inter("t1", "pint_a", "resolved", grant, { decision: "allow_once", grantedPermissions: null }),
    inter("t1", "pint_b", "pending", grant),
    inter("t1", "pint_b", "resolved", grant, { decision: "deny" }),
    inter("t1", "pint_b", "pending", grant),
    inter("t1", "pint_c", "pending", grant),
    completed("t1"),
  ],
  questions_forms: [
    started("t1"),
    inter("t1", "pint_q", "pending", question),
    inter("t1", "pint_q", "resolved", question, { answers: { q1: "A" } }),
    inter("t1", "pint_q", "interrupted", question, null, undefined, "late"),
    inter("t1", "pint_f", "pending", plugin, null, pluginOrigin),
    inter("t1", "pint_f", "resolved", plugin, { description: { payload: { color: "red" } } }, pluginOrigin),
    inter("t1", "pint_g", "pending", plugin, null, pluginOrigin),
    inter("t1", "pint_g", "interrupted", plugin, null, pluginOrigin, "cancelled by user"),
    inter("t1", "pint_q2", "pending", question),
    completed("t1"),
  ],
  file_change: [
    started("t1"),
    fc("item/started", "t1", "fc1", "pending", [{ path: "a.txt", kind: "add", diff: "+a" }, { path: "b.txt", kind: "update", diff: "-b\n+b" }]),
    fcOut("t1", "fc1", "patching a\npart"),
    fcOut("t1", "fc1", "ial line"),
    fc("item/completed", "t1", "fc1", "completed", [{ path: "b.txt", kind: "update" }, { path: "a.txt", kind: "add", diff: "+a2" }, { path: "c.txt", movePath: "d.txt", kind: "update" }]),
    fc("item/started", "t1", "fc2", "pending", [{ path: "x.txt", kind: "update" }]),
    fcOut("t1", "fc2", "trailing partial"),
    completed("t1"),
    started("t2"),
    fc("item/started", "t2", "fc1", "pending", [{ path: "a.txt", kind: "update" }]),
    fcOut("t2", "fc3", "orphan output"),
    completed("t2", "failed", { message: "boom" }),
  ],
  file_change_denied: [
    started("t1"),
    fc("item/started", "t1", "fc1", "pending", [{ path: "a.txt", kind: "update", diff: "+x" }], { approvalStatus: "waiting_for_approval" }),
    fc("item/completed", "t1", "fc1", "failed", [{ path: "a.txt", kind: "update", diff: "+x" }], { approvalStatus: "denied" }),
    fc("item/started", "t1", "fc2", "pending", [{ path: "a.txt" }, { path: "a.txt" }]),
    fc("item/completed", "t1", "fc2", "failed", [{ path: "a.txt" }, { path: "a.txt" }]),
    completed("t1"),
  ],
  file_change_reorder: [
    started("t1"),
    inter("t1", "pint_x", "pending", grant),
    fc("item/started", "t1", "fc1", "pending", [{ path: "a.txt", kind: "update" }]),
    inter("t1", "pint_y", "pending", grant),
    fc("item/completed", "t1", "fc1", "completed", [{ path: "z.txt", kind: "add" }, { path: "a.txt", kind: "update", diff: "+a" }]),
    fc("item/started", "t1", "fc4", "pending", []),
    fcOut("t1", "fc4", "line one\nline"),
    fc("item/completed", "t1", "fc4", "completed", [{ path: "q.txt", kind: "add" }]),
    completed("t1"),
  ],
  file_change_open: [
    started("t1"),
    fc("item/started", "t1", "fc1", "pending", [{ path: "a.txt", kind: "update" }]),
    fcOut("t1", "fc1", "half"),
  ],
  compaction: [
    started("t1"),
    comp("item/started", "t1", "cmp1", "pending"),
    comp("item/completed", "t1", "cmp1"),
    comp("item/completed", "t1", "cmp1"),
    completed("t1"),
    started("t2"),
    comp("item/started", "t2", "cmp2", "pending"),
    completed("t2", "failed", { message: "compaction blew up" }),
    started("t3"),
    comp("item/started", "t3", "cmp3", "pending"),
    { type: "system/thread/interrupted", scope: thread, reason: "manual-stop" },
    completed("t3", "interrupted"),
    started("t4"),
    { type: "thread/compacted", scope: turn("t4"), providerThreadId: "p1" },
    { type: "thread/context/cleared", scope: turn("t4") },
    completed("t4"),
    started("t5"),
    comp("item/started", "t5", "cmp5", "pending"),
    { type: "provider/warning", scope: turn("t5"), category: "compaction-skipped", summary: "Skipped", details: "too small" },
    completed("t5"),
    started("t6"),
    comp("item/started", "t6", "cmp6", "pending"),
  ],
};

const write = (name: string, events: any[]) => {
  const results = OPTIONS.map((options) => ({ options, projection: buildEventProjection(events, options as any) }));
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ compacted: events, results }, null, 1) + "\n");
};
for (const [name, events] of Object.entries(scenarios)) write(name, seqd(events));
for (const file of readdirSync(PARITY).filter((f) => f.endsWith(".json"))) {
  const { events } = JSON.parse(readFileSync(`${PARITY}/${file}`, "utf8"));
  if (Array.isArray(events) && events.length) write(`parity-${file.replace(/\.json$/, "")}`, events);
}
