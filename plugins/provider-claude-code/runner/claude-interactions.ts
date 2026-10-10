import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isApprovalPendingInteractionResolution as isApproval,
  isUserQuestionPendingInteractionResolution as isAnswer,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  type ApprovalPendingInteractionPayload as ApprovalPayload,
  type PendingInteractionGrantablePermissionProfile as Permissions,
  type PendingInteractionPayload as Payload,
  type PendingInteractionResolution as Resolution,
  type PermissionEscalation,
  type UserQuestionPendingInteractionPayload as QuestionPayload,
} from "@bb/domain";
import { z } from "zod";
import { parseBashCommand } from "./claude-tools.js";
import type { Interaction } from "@bb/runner";

export interface PermissionHost {
  requestInteraction(args: Interaction): Promise<Resolution>;
  itemId(toolUseId: string): string;
  turnId(): string | null;
  mode(): PermissionMode;
  escalation(): PermissionEscalation;
}

type Options = Parameters<CanUseTool>[2];
type Input = Record<string, unknown>;
type Outcome = Resolution | PermissionResult;

const INVALID_RESPONSE = "Invalid interactive response payload";
const WORKSPACE_DENIAL =
  "bb's workspace sandbox allows work inside the current workspace only. Stay inside the workspace or explain why extra access is needed.";
const NETWORK_TOOLS = ["WebFetch", "WebSearch", "SandboxNetworkAccess"];
const READ_TOOLS = ["Read", "Grep", "Glob", "LS"];
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

const text = z.string().min(1);
const questionSchema = z.object({
  question: text,
  header: text,
  options: z
    .array(z.object({ label: text, description: text }))
    .min(2)
    .max(USER_QUESTION_MAX_OPTIONS),
  multiSelect: z.boolean(),
});
const questionsSchema = z
  .array(questionSchema)
  .min(1)
  .max(USER_QUESTION_MAX_QUESTIONS)
  .refine((all) => new Set(all.map((q) => q.question)).size === all.length);
const suggestionsSchema = z.array(
  z.looseObject({ type: z.string(), directories: z.unknown().optional() }),
);

function permissionProfile(toolName: string, options: Options) {
  const parsed = suggestionsSchema.safeParse(options.suggestions).data ?? [];
  const added = parsed.filter((entry) => entry.type === "addDirectories");
  const paths = z.array(z.string());
  const suggested = added.flatMap(
    (entry) => paths.safeParse(entry.directories).data ?? [],
  );
  const blocked =
    options.blockedPath === undefined ? [] : [options.blockedPath];
  const directories = [...new Set([...suggested, ...blocked])];
  const fileSystem = {
    read: WRITE_TOOLS.includes(toolName) ? [] : directories,
    write: READ_TOOLS.includes(toolName) ? [] : directories,
  };
  const rules = parsed.some((entry) => entry.type === "addRules");
  const network = NETWORK_TOOLS.includes(toolName) || rules;
  return {
    network: network ? { enabled: true } : null,
    fileSystem: directories.length === 0 ? null : fileSystem,
  };
}

function sessionUpdates(permissions: Permissions, toolName: string | null) {
  const { read = [], write = [] } = permissions.fileSystem ?? {};
  const directories = [...new Set([...read, ...write])];
  const destination = "session" as const;
  const updates: PermissionUpdate[] = [];
  if (directories.length > 0) {
    updates.push({ type: "addDirectories", directories, destination });
  }
  if (toolName && permissions.network?.enabled === true) {
    const rules = [{ toolName }];
    updates.push({ type: "addRules", rules, behavior: "allow", destination });
  }
  return updates.length > 0 ? updates : undefined;
}

function approvalPayload(
  toolName: string,
  itemId: string,
  input: Input,
  reason: string | null,
  permissions: Permissions,
) {
  const bash = parseBashCommand(input);
  const path = input.file_path ?? input.path;
  const edits = WRITE_TOOLS.includes(toolName) && typeof path === "string";
  const grantable = sessionUpdates(permissions, toolName) !== undefined;
  const availableDecisions: ApprovalPayload["availableDecisions"] = grantable
    ? ["allow_once", "allow_for_session", "deny"]
    : ["allow_once", "deny"];
  const base = { kind: "approval" as const, reason, availableDecisions };
  const sessionGrant = permissions;
  if (toolName === "Bash" && bash !== undefined) {
    const actions = [{ type: "unknown" as const, command: bash.command }];
    const subject = { kind: "command" as const, itemId, ...bash, actions };
    return { ...base, subject: { ...subject, sessionGrant } };
  }
  if (edits && path !== "") {
    const subject = { kind: "file_change" as const, itemId, writeScope: null };
    return { ...base, subject: { ...subject, sessionGrant } };
  }
  const kind = "permission_grant" as const;
  return { ...base, subject: { kind, itemId, toolName, permissions } };
}

function questionPayload(
  itemId: string,
  questions: z.infer<typeof questionSchema>[],
): QuestionPayload {
  return {
    kind: "user_question",
    questions: questions.map((question, index) => {
      const id = `${itemId}:question-${index + 1}`;
      const options = question.options.map((option, optionIndex) => {
        const value = `${id}:option-${optionIndex + 1}`;
        return { value, label: option.label, description: option.description };
      });
      const { question: prompt, header: shortLabel, multiSelect } = question;
      const asked = { id, prompt, shortLabel, multiSelect, options };
      return { ...asked, allowFreeText: true };
    }),
  };
}

function answeredInput(payload: QuestionPayload, resolution: Resolution) {
  if (!isAnswer(resolution)) return undefined;
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const question of payload.questions) {
    const answer = resolution.answers[question.id];
    const options = question.options ?? [];
    const labels = (answer?.selected ?? []).map(
      (value) => options.find((option) => option.value === value)?.label,
    );
    const chosen = labels.join(", ");
    const typed = answer?.freeText;
    const reply = chosen && typed ? `${chosen}; ${typed}` : chosen || typed;
    if (labels.includes(undefined) || !reply) return undefined;
    answers[question.prompt] = reply;
    const annotated = chosen !== "" && typed !== undefined;
    if (annotated) annotations[question.prompt] = { notes: typed };
  }
  const questions = payload.questions.map((question) => ({
    question: question.prompt,
    header: question.shortLabel ?? question.prompt.slice(0, 12),
    options: (question.options ?? []).map(({ label, description }) => ({
      label,
      description: description ?? label,
    })),
    multiSelect: question.multiSelect,
  }));
  const annotated = Object.keys(annotations).length > 0;
  return { questions, answers, ...(annotated ? { annotations } : {}) };
}

function approvalResult(
  payload: ApprovalPayload,
  resolution: Resolution,
  input: Input,
): PermissionResult | undefined {
  if (!isApproval(resolution)) return undefined;
  const { subject } = payload;
  if (resolution.decision === "deny") {
    const message = "Permission request denied";
    return { behavior: "deny", message, decisionClassification: "user_reject" };
  }
  const allowed = { behavior: "allow" as const, updatedInput: input };
  if (resolution.decision === "allow_once") {
    return { ...allowed, decisionClassification: "user_temporary" };
  }
  const granted = resolution.grantedPermissions;
  if (granted === null) return undefined;
  const ruleTool = subject.kind === "command" ? "Bash" : null;
  const granting = subject.kind === "permission_grant";
  const toolName = granting ? subject.toolName : ruleTool;
  const updatedPermissions = sessionUpdates(granted, toolName);
  const decisionClassification = "user_permanent" as const;
  const session = { ...allowed, decisionClassification };
  return updatedPermissions ? { ...session, updatedPermissions } : session;
}

export class ClaudePermissions {
  private readonly pending = new Set<(result: PermissionResult) => void>();

  constructor(private readonly host: PermissionHost) {}

  cancelPending(message: string) {
    const stopped = { behavior: "deny" as const, interrupt: true, message };
    for (const settle of [...this.pending]) settle(stopped);
  }

  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    await new Promise((settled) => setImmediate(settled));
    const decided = await this.decide(toolName, input, options);
    return { ...decided, toolUseID: options.toolUseID };
  };

  private async decide(
    toolName: string,
    input: Input,
    options: Options,
  ): Promise<PermissionResult> {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const allow = { behavior: "allow" as const, updatedInput: input };
    const { signal, toolUseID, decisionReason } = options;
    if (toolName === "AskUserQuestion") {
      const questions = questionsSchema.safeParse(input.questions).data;
      if (questions === undefined) return deny("Invalid AskUserQuestion input");
      const payload = questionPayload(toolUseID, questions);
      const cancelled = "User question request cancelled";
      const resolution = await this.request(payload, signal, cancelled);
      if ("behavior" in resolution) return resolution;
      const updatedInput = answeredInput(payload, resolution);
      if (updatedInput === undefined) return deny(INVALID_RESPONSE);
      return { behavior: "allow", updatedInput };
    }
    const unattended = this.host.escalation() === "deny";
    const mode = this.host.mode();
    const escaping = input.dangerouslyDisableSandbox === true;
    const asks =
      options.blockedPath !== undefined ||
      decisionReason !== undefined ||
      (options.suggestions?.length ?? 0) > 0;
    if (toolName === "Bash" && unattended && escaping) {
      return deny(WORKSPACE_DENIAL);
    }
    if (!asks || mode === "bypassPermissions") return allow;
    if (unattended) return deny(decisionReason ?? WORKSPACE_DENIAL);
    const prompt = options.title ?? options.description ?? null;
    const reason = decisionReason ?? prompt;
    const profile = permissionProfile(toolName, options);
    const itemId = this.host.itemId(toolUseID);
    const payload = approvalPayload(toolName, itemId, input, reason, profile);
    const cancelled = "Interactive request cancelled";
    const resolution = await this.request(payload, signal, cancelled);
    if ("behavior" in resolution) return resolution;
    const result = approvalResult(payload, resolution, input);
    return result ?? deny(INVALID_RESPONSE);
  }

  private request(payload: Payload, signal: AbortSignal, cancelled: string) {
    return new Promise<Outcome>((settle) => {
      const finish = (outcome: Outcome) => {
        this.pending.delete(finish);
        signal.removeEventListener("abort", abort);
        settle(outcome);
      };
      const abort = () => finish({ behavior: "deny", message: cancelled });
      const failed = (error: unknown) => {
        const reason = error instanceof Error ? error.message : "";
        const message = reason || "Interactive request failed";
        finish({ behavior: "deny", message });
      };
      this.pending.add(finish);
      signal.addEventListener("abort", abort, { once: true });
      const turnId = this.host.turnId();
      this.host.requestInteraction({ payload, turnId }).then(finish, failed);
    });
  }
}
