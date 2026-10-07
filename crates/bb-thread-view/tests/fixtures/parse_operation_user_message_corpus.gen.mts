import * as fs from "node:fs";
const SRC = process.cwd() + "/src";
const P = await import(SRC + "/parse-operation-message.ts");
const U = await import(SRC + "/user-message-parsing.ts");
const WT = process.env.WT ?? "../..";
const OUT = WT + "/crates/bb-thread-view/tests/fixtures";
const T = "thr_1";
const th = { kind: "thread" };
const tu = (id) => ({ kind: "turn", turnId: id });
let seq = 1;
const meta = () => ({ id: `ev_${seq}`, seq: seq++, createdAt: 1700000000000 + seq * 1000 });
const ev = (o) => ({ threadId: T, scope: th, ...o });

const hand = [];
const H = (o) => hand.push(ev(o));
H({ type: "provider/modelFallback", originalModel: "opus", fallbackModel: "sonnet", message: "Overloaded" });
H({ type: "provider/modelFallback", originalModel: "a", fallbackModel: "b", message: "", scope: tu("t1") });
for (const entries of [[], [
  { name: "PATH", value: "/usr/bin", source: "shell" },
  { name: "TOKEN", value: null, redacted: true, source: { plugin: "secrets" }, reason: "from vault" },
  { name: "HOME", value: "/h", source: { core: "agent-env" }, reason: "" },
]]) H({ type: "provider.env-resolved", entries });
for (const category of ["deprecation", "config", "other", undefined])
  for (const [summary, details] of [["  Sum  ", "Det"], [undefined, "Only details"], ["", ""], ["S", undefined], ["   ", "d"]])
    H({ type: "provider/warning", category, summary, details });
for (const reason of ["host-removed", "manual-stop", "host-daemon-restarted", "provider-turn-idle"])
  H({ type: "system/thread/interrupted", reason });
H({ type: "system/thread/interrupted", reason: "manual-stop", cause: "host-connection-lost" });
const tEntries = [
  { type: "step", key: " clone ", text: " Cloning repo ", status: "completed" },
  { type: "step", key: "deps", text: "Installing" },
  { type: "log", key: "l1", text: "  output line  ", status: "ignored" },
  { type: "step", key: "  ", text: "blank key" },
  { type: "log", key: "l2", text: "  ﻿ " },
  { type: "step", key: "fail", text: "Failing", status: "failed" },
];
for (const status of ["active", "completed", "failed", "cancelled"])
  H({ type: "system/thread-provisioning", provisioningId: "prov_1", status, entries: status === "active" ? tEntries : [] });
H({ type: "system/thread-provisioning", provisioningId: "thread-start:abc", status: "active", entries: tEntries });
H({ type: "system/thread-provisioning", provisioningId: "prov_2", status: "completed", entries: tEntries.slice(3, 5) });
const own = (action, prevT, nextT) => ({ action, previousParentThreadId: prevT === undefined ? null : "thr_p", previousParentThreadTitle: prevT ?? null, nextParentThreadId: nextT === undefined ? null : "thr_n", nextParentThreadTitle: nextT ?? null });
for (const status of ["started", "completed", "failed", "noop"])
  for (const metadata of [undefined, own("assign", undefined, " Parent A "), own("release", "Old parent", undefined), own("transfer", "Old", "  "), { action: "bogus" }, { action: "assign" }, { ...own("assign", undefined, "N"), branch: "feat/x", extra: 1 }])
    for (const message of ["", "  Ownership change completed ", "Moved it"])
      H({ type: "system/operation", operationId: "op_1", operation: "ownership_change", status, message, metadata });
for (const operation of ["context_clear", "rename_branch", "plugin_interaction", "edit_message", "archive", "émigré_op_x"])
  for (const status of ["started", "completed", "failed", "noop"])
    H({ type: "system/operation", operationId: "op_2", operation, status, message: status === "failed" ? "Something broke" : " Context cleared ", metadata: { branch: status === "noop" ? "" : "main" } });
H({ type: "system/operation", operationId: "op_3", operation: "rename", status: "completed", message: "Rename completed" });
H({ type: "thread/context/cleared", scope: tu("t9") });
const q = (status, resolution, statusReason = null) => ({ id: "int_q", status, statusReason, payload: { kind: "user_question", questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }] }, resolution, origin: { kind: "provider" } });
for (const [s, r] of [["pending", null], ["resolving", null], ["resolved", { answers: { q1: { answers: ["A"] } } }], ["interrupted", null]])
  H({ type: "system/interaction/lifecycle", scope: tu("t2"), interaction: q(s, r ?? undefined, s === "interrupted" ? "Turn stopped" : null) });
const form = (status, presentation, description) => ({ id: "int_f", status, statusReason: null, origin: { kind: "plugin", pluginId: "tasks", rendererId: "task-form" }, payload: { kind: "plugin", title: "Task form", presentation }, resolution: description === undefined ? undefined : { description } });
for (const [s, p, d] of [["pending", undefined, undefined], ["resolving", undefined, undefined], ["resolved", undefined, { title: "Created task", detail: null, payload: { id: 7 } }], ["interrupted", { label: { pending: "P", completed: "C" }, icon: { glyph: "X" }, title: "orig" }, { detail: "why" }], ["resolved", { label: { pending: "P", completed: "C" } }, {}]])
  H({ type: "system/interaction/lifecycle", interaction: form(s, p, d) });
const ap = (status, subject, decision) => ({ id: "int_a", status, statusReason: status === "interrupted" ? "gone" : null, origin: { kind: "provider" }, payload: { kind: "approval", subject }, resolution: decision ? { decision } : undefined });
const grant = { kind: "permission_grant", itemId: "item_1", toolName: "Bash" };
for (const [s, d] of [["pending"], ["resolving"], ["interrupted"], ["resolved", "deny"], ["resolved", "allow_once"], ["resolved", "allow_for_session"], ["resolved", "allow"]])
  H({ type: "system/interaction/lifecycle", interaction: ap(s, s === "resolving" ? { ...grant, toolName: null } : grant, d) });
H({ type: "system/interaction/lifecycle", interaction: ap("pending", { kind: "command", itemId: "i" }) });
H({ type: "system/interaction/lifecycle", interaction: { id: "x", status: "pending", statusReason: null, payload: { kind: "other" } } });
for (const [message, detail] of [["Boom", "Boom"], ["Boom", "stack"], ["", null], [undefined, "d"], ["m", ""]]) {
  H({ type: "system/error", message, detail });
  H({ type: "provider/error", message, detail, errorInfo: message === "Boom" ? { kind: "rate_limit" } : null, willRetry: detail === "stack" ? true : undefined });
}
H({ type: "item/completed", item: { type: "agentMessage", id: "x", text: "hi" } });

const fixtureFiles = ["claude", "codex"].flatMap((d) => fs.readdirSync(`${WT}/packages/runner/test/fixtures/${d}`).filter((f) => f.endsWith(".events.json")).map((f) => `${WT}/packages/runner/test/fixtures/${d}/${f}`));
const fixtureEvents = fixtureFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")).map((e) => ({ threadId: T, ...e })));
const isOpEvent = (e) => ["provider/modelFallback", "provider.env-resolved", "provider/warning", "system/thread/interrupted", "system/thread-provisioning", "system/operation", "system/interaction/lifecycle", "thread/context/cleared", "provider/error", "system/error", "item/completed", "turn/started"].includes(e.type);
const fixtureOp = fixtureEvents.flat().filter(isOpEvent);
const opEvents = [...hand, ...fixtureOp.filter((e) => e.type !== "item/completed" && e.type !== "turn/started"), ...fixtureOp.filter((e) => e.type === "item/completed").slice(0, 12), ...fixtureOp.filter((e) => e.type === "turn/started").slice(0, 4)];
const optionSets = [
  { includeDiagnosticOperations: true, threadStatus: "error", threadName: "  My thread " },
  { includeDiagnosticOperations: false, threadStatus: "idle", threadName: "  " },
];
const clone = (x) => JSON.parse(JSON.stringify(x));
const opCases = [];
for (const event of opEvents) for (const options of optionSets) {
  const m = meta();
  const parsed = P.parseOperationMessage(clone(event), m, options);
  let interrupted = null, finalized = null;
  if (parsed?.kind === "operation") {
    interrupted = clone(parsed); P.interruptOperationMessage(interrupted);
    finalized = clone(parsed); P.finalizeOperationMessage(finalized, options);
  }
  opCases.push({ event, meta: m, options, expected: clone({ parsed, interrupted, finalized, error: P.parseErrorMessage(clone(event), m) }) });
}
const mergeCases = [];
const A = [{ type: "step", key: "a", text: "A", status: "started" }, { type: "log", key: "l", text: "L" }];
for (const [ex, inc] of [[undefined, undefined], [[], []], [A, undefined], [undefined, A], [A, [{ type: "step", key: "a", text: "A2", status: "completed" }, { type: "log", key: "l", text: "L2" }, { type: "step", key: "b", text: "B" }]]])
  mergeCases.push({ existing: ex ?? null, incoming: inc ?? null, expected: P.mergeTranscriptEntries(ex, inc) ?? null });
const statusTitles = Object.fromEntries(["pending", "completed", "error", "interrupted"].map((s) => [s, P.provisioningTitleForStatus(s)]));
fs.writeFileSync(OUT + "/parse_operation_corpus.json", JSON.stringify({ cases: opCases, merge: mergeCases, statusTitles }, null, 0));

const txt = (text, mentions = [], visibility) => ({ type: "text", text, mentions, ...(visibility ? { visibility } : {}) });
const inputs = [
  [txt("hello")],
  [],
  [txt("")],
  [txt("secret", [], "agent-only")],
  [txt("😀 ab @file.ts", [{ kind: "file", path: "/a/file.ts", start: 6, end: 14 }, { kind: "x", start: -1, end: 2 }, { kind: "x", start: 3, end: 3 }, { kind: "x", start: 0, end: 15 }]), txt(" and @𝒳y", [{ kind: "thread", threadId: "thr_9", start: 5, end: 8 }])],
  [{ type: "image", url: "https://x/y.png" }, { type: "image", url: "" }, { type: "localImage", path: "/i.png" }, { type: "localImage", path: "" }, { type: "localFile", path: "/f.txt" }, { type: "localFile", path: "/g.txt", visibility: "agent-only" }, { type: "skill", name: "s" }],
  [txt("[bb message from thread:thr_abc;title=Hi]\n  body text")],
  [txt("[bb message from thread:thr_abc]")],
  [txt("[bb system] something happened")],
  [txt("  [bb message from thread:thr_abc] not at start")],
  [{ type: "localFile", path: "/only.txt" }],
];
const userCases = [];
const accepted = { meta: { id: "ev_acc", seq: 900, createdAt: 1700000900000 }, turnId: "turn_a" };
const acceptedOther = { meta: { id: "ev_acc2", seq: 901, createdAt: 1700000901000 }, turnId: "turn_b" };
const targets = [{ kind: "thread-start" }, { kind: "new-turn" }, { kind: "turn", expectedTurnId: "turn_a" }, { kind: "turn", expectedTurnId: null }, { kind: "turn", expectedTurnId: "" }];
const evVariants = [
  {}, { initiator: "agent", senderThreadId: "thr_s" }, { initiator: "system", systemMessageKind: "thread-event", systemMessageSubject: { threadId: "thr_z" } },
  { senderThreadId: null, systemMessageKind: null, systemMessageSubject: null },
];
let i = 0;
for (const input of inputs) for (const target of targets) {
  const variant = evVariants[i++ % evVariants.length];
  const event = ev({ type: "client/turn/requested", clientRequestId: "req_1", initiator: "user", target, input, ...variant });
  for (const acc of [undefined, accepted, acceptedOther]) for (const status of ["pending", "accepted", "rejected"]) {
    if (status !== "accepted" && acc) continue;
    const m = meta();
    userCases.push({ kind: "client", event, meta: m, status, accepted: acc ?? null, expected: { messages: U.clientRequestUserMessages(clone(event), m, status, acc), turnRequestKind: U.turnRequestKind(event, acc) } });
  }
}
for (const inputGroups of [[inputs[0], inputs[1], inputs[5], inputs[6]], [], null]) {
  const event = ev({ type: "client/turn/requested", clientRequestId: "req_g", initiator: "user", target: { kind: "turn", expectedTurnId: "turn_a" }, input: inputs[0], inputGroups });
  for (const acc of [undefined, accepted]) {
    const m = meta();
    userCases.push({ kind: "client", event, meta: m, status: "accepted", accepted: acc ?? null, expected: { messages: U.clientRequestUserMessages(clone(event), m, "accepted", acc), turnRequestKind: U.turnRequestKind(event, acc) } });
  }
}
const providerEvents = [
  ev({ type: "item/completed", scope: tu("t1"), item: { type: "userMessage", id: "um_1", content: [{ type: "text", text: "hi " }, { type: "image", url: "u" }, { type: "text", text: "there" }] } }),
  ev({ type: "item/completed", item: { type: "userMessage", id: "um_2", parentToolCallId: "call_1", content: [{ type: "text", text: "sub" }] } }),
  ev({ type: "item/completed", item: { type: "userMessage", id: "um_3", parentToolCallId: "", content: [{ type: "text", text: "x" }] } }),
  ev({ type: "item/completed", item: { type: "userMessage", id: "um_4", content: [] } }),
  ev({ type: "item/started", item: { type: "userMessage", id: "um_5", content: [{ type: "text", text: "x" }] } }),
  ...fixtureEvents.flat().filter((e) => e.type === "item/completed"),
];
for (const event of providerEvents) { const m = meta(); userCases.push({ kind: "provider", event, meta: m, expected: U.parseProviderUserMessage(clone(event), m) }); }
const promptCases = inputs.map((input) => ({ input, expected: U.parsePromptInput(input) }));
const acceptedCases = fixtureEvents.map((events) => {
  const withMeta = events.filter((e) => ["turn/input/accepted", "turn/started", "thread/started"].includes(e.type)).map((event) => ({ event, meta: meta() }));
  withMeta.push({ event: ev({ type: "turn/input/accepted", scope: tu("dup"), clientRequestId: withMeta.find((e) => e.event.type === "turn/input/accepted")?.event.clientRequestId ?? "none" }), meta: meta() });
  const map = U.buildAcceptedClientRequestById(withMeta);
  return { events: withMeta, expected: Object.fromEntries(map) };
});
const preserve = Object.fromEntries(["starting", "active", "pending", "idle", "error", "archived"].map((s) => [s, U.shouldPreservePendingMessages(s)]));
fs.writeFileSync(OUT + "/user_message_corpus.json", JSON.stringify({ cases: userCases, prompts: promptCases, accepted: acceptedCases, preserve }, null, 0));
console.log(opCases.length, mergeCases.length, userCases.length, promptCases.length, acceptedCases.length);
