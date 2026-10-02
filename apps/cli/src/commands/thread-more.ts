import type {
  PendingInteraction,
  PendingInteractionApprovalDecision,
  PendingInteractionResolution,
  PendingInteractionUserAnswer,
} from "@bb/domain";
import {
  clip,
  confirm,
  loaded,
  parseJson,
  threadTarget,
  validId,
  type Call,
} from "../call.js";
import { usageError, type Run } from "../engine.js";
import { queueWait } from "../render.js";

type ApplyAnswer = (
  answer: PendingInteractionUserAnswer,
  value: string,
) => void;

function interactionTarget(c: Call) {
  const interactionId = validId(c.arg("interactionId"), "<interactionId>");
  return { threadId: threadTarget(c), interactionId };
}

export const threadInteractionsList: Run = async (c) => {
  const threadId = threadTarget(c);
  const interactions = await c.sdk.threads.interactions.list({ threadId });
  const { formatPendingInteractionSummary } = await import("@bb/core-ui");
  const rows = interactions.map((interaction) => ({
    id: interaction.id,
    kind: interaction.payload.kind,
    status: interaction.status,
    summary: formatPendingInteractionSummary({ interaction }),
  }));
  c.rows(rows, ["id", "kind", "status", "summary"], interactions);
};

export const threadInteractionsShow: Run = async (c) => {
  c.out(await c.sdk.threads.interactions.get(interactionTarget(c)));
};

function userAnswer(
  c: Call,
  interaction: PendingInteraction,
): PendingInteractionResolution {
  if (!loaded().domain.isUserQuestionPendingInteraction(interaction)) {
    throw usageError(`Interaction ${interaction.id} is not a question.`);
  }
  const { questions } = interaction.payload;
  const answers: Record<string, PendingInteractionUserAnswer> = {};
  const record = (raw: string, apply: ApplyAnswer): void => {
    const [id] = raw.split("=", 1);
    const named = questions.find((question) => question.id === id);
    const only = questions.length === 1 ? questions[0] : undefined;
    const question = named ?? only;
    if (question === undefined) {
      const ids = questions.map((candidate) => candidate.id).join(", ");
      throw usageError(`'${raw}' must start with a question ID: ${ids}.`);
    }
    const value = named === undefined ? raw : raw.slice(named.id.length + 1);
    apply((answers[question.id] ??= { selected: [] }), value);
  };
  for (const raw of c.list("answer")) {
    record(raw, (answer, value) => answer.selected.push(value));
  }
  for (const raw of c.list("text")) {
    record(raw, (answer, value) => (answer.freeText = value));
  }
  return { kind: "user_answer", answers };
}

async function resolution(
  c: Call,
  interaction: PendingInteraction,
): Promise<PendingInteractionResolution> {
  const grant = c.choice("grant", ["turn", "session"]);
  const answering = c.on("answer") || c.on("text");
  const ways = [c.on("approve"), c.on("deny"), grant !== undefined, answering];
  if (ways.filter(Boolean).length !== 1) {
    const choices = "--approve, --deny, --grant, --answer/--text or --value";
    throw usageError(`Provide exactly one of ${choices}.`);
  }
  if (answering) return userAnswer(c, interaction);
  if (!loaded().domain.isApprovalPendingInteraction(interaction)) {
    const hint = "Use --answer or --text for a question, --value for a form.";
    throw usageError(`Interaction ${interaction.id} is not an approval.`, hint);
  }
  const offered = interaction.payload.availableDecisions;
  const wanted: PendingInteractionApprovalDecision[] = c.on("deny")
    ? ["deny"]
    : grant === "session"
      ? ["allow_for_session"]
      : grant === "turn"
        ? ["allow_once"]
        : ["allow_once", "allow_for_session"];
  const decision = wanted.find((candidate) => offered.includes(candidate));
  if (decision === undefined) {
    const available = offered.join(", ");
    throw usageError(`Interaction ${interaction.id} offers: ${available}.`);
  }
  const ui = await import("@bb/core-ui");
  return ui.buildPendingInteractionApprovalResolution(interaction, decision);
}

export const threadInteractionsResolve: Run = async (c) => {
  const target = interactionTarget(c);
  const { interactions } = c.sdk.threads;
  const raw = c.flag("value");
  let updated: PendingInteraction;
  if (raw === undefined) {
    const interaction = await interactions.get(target);
    const resolved = await resolution(c, interaction);
    updated = await interactions.resolve({ ...target, resolution: resolved });
  } else {
    const { jsonValueSchema } = loaded().domain;
    const value = jsonValueSchema.parse(parseJson(raw, "--value"));
    updated = await interactions.respond({ ...target, value });
  }
  const delivering = updated.status === "resolving";
  const state = delivering
    ? "submitted; delivering to the provider"
    : "resolved";
  c.out(updated, `Interaction ${updated.id} ${state}`);
};

export const threadQueueList: Run = async (c) => {
  const { threads } = c.sdk;
  const { threadId } = c.args;
  const queued =
    threadId === undefined
      ? await threads.queue.list()
      : await threads.queuedMessages.list({ threadId });
  const rows = queued.map((row) => {
    const texts = row.content.flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    );
    const failed = row.failureReason;
    const waiting = failed === null ? queueWait(row) : `Failed: ${failed}`;
    const message = clip(texts.join(" ") || "(no text)", 40);
    return { id: row.id, thread: row.threadId, message, waiting };
  });
  c.rows(rows, ["id", "thread", "message", "waiting"], queued);
};

function queuedMessage(c: Call) {
  const threadId = validId(c.arg("threadId"), "<threadId> argument");
  const queuedMessageId = validId(c.arg("messageId"), "<messageId> argument");
  return { threadId, queuedMessageId };
}

export const threadQueueSend: Run = async (c) => {
  const target = queuedMessage(c);
  const mode = c.choice("mode", ["auto", "steer"]) ?? "auto";
  const { queuedMessages } = c.sdk.threads;
  const result = await queuedMessages.send({ ...target, mode });
  const text = `Queued message ${target.queuedMessageId} ${result.delivery}`;
  c.out({ ...target, ...result }, text);
};

export const threadQueueDelete: Run = async (c) => {
  const target = queuedMessage(c);
  const result = await c.sdk.threads.queuedMessages.delete(target);
  const text = `Queued message ${target.queuedMessageId} deleted`;
  c.out({ ...target, ...result }, text);
};

export const threadSectionList: Run = async (c) => {
  c.rows(await c.sdk.threadSections.list(), ["id", "name"]);
};

export const threadSectionCreate: Run = async (c) => {
  const section = await c.sdk.threadSections.create({ name: c.arg("name") });
  c.out(section, `Section ${section.id} created`);
};

export const threadSectionRename: Run = async (c) => {
  const change = { id: c.arg("id"), name: c.arg("name") };
  const section = await c.sdk.threadSections.update(change);
  c.out(section, `Section ${section.id} renamed to ${section.name}`);
};

export const threadSectionDelete: Run = async (c) => {
  const id = c.arg("id");
  await confirm(c, `Delete section ${id}? Its threads stay, unsectioned.`);
  const result = await c.sdk.threadSections.delete({ id });
  const moved = `${result.updatedThreadCount} thread(s) unsectioned`;
  c.out(result, `Section ${result.id} deleted; ${moved}`);
};
