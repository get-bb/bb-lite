import { resolve } from "node:path";
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
import type { Interaction } from "./provider.js";

export interface PermissionHost {
  requestInteraction(args: Interaction): Promise<Resolution>;
  itemId(toolUseId: string): string;
  turnId(): string | null;
  mode(): PermissionMode;
  escalation(): PermissionEscalation;
  planApproved(): void;
}

interface Grant {
  toolName: string;
  permissions: Permissions;
}

type Options = Parameters<CanUseTool>[2];
type Input = Record<string, unknown>;

const QUESTION_TOOL = "AskUserQuestion";
const PLAN_TOOL = "ExitPlanMode";
const INVALID_RESPONSE = "Invalid interactive response payload";
const PLAN_REJECTED =
  "The user rejected this plan. Do not call ExitPlanMode again with the same plan. Use AskUserQuestion to find out what they want changed, revise the plan, and only then propose it again.";
const WORKSPACE_DENIAL =
  "bb's workspace sandbox allows work inside the current workspace only. Stay inside the workspace or explain why extra access is needed.";
const READONLY_DENIAL =
  "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.";
const NETWORK_TOOLS = ["WebFetch", "WebSearch", "SandboxNetworkAccess"];
const FILE_ACCESS: Record<string, "read" | "write" | "both" | undefined> = {
  Read: "read",
  Grep: "read",
  Glob: "read",
  LS: "read",
  Edit: "write",
  Write: "write",
  NotebookEdit: "write",
  Bash: "both",
};

const text = z.string().min(1);
const planSchema = z.object({ plan: text, planFilePath: text.optional() });
const optionSchema = z.object({ label: text, description: text });
const questionSchema = z.object({
  question: text,
  header: text,
  options: z.array(optionSchema).min(2).max(USER_QUESTION_MAX_OPTIONS),
  multiSelect: z.boolean(),
});
const questionsSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(USER_QUESTION_MAX_QUESTIONS)
    .refine((all) => new Set(all.map((q) => q.question)).size === all.length),
});
const suggestionSchema = z.union([
  z.object({ type: z.literal("addRules"), rules: z.array(z.unknown()).min(1) }),
  z.object({
    type: z.literal("addDirectories"),
    directories: z.array(z.string()).min(1),
  }),
]);

function permissionProfile(toolName: string, options: Options): Permissions {
  const suggestions = (options.suggestions ?? []).flatMap((suggestion) => {
    const parsed = suggestionSchema.safeParse(suggestion);
    return parsed.success ? [parsed.data] : [];
  });
  const suggested = suggestions.flatMap((suggestion) =>
    suggestion.type === "addDirectories" ? suggestion.directories : [],
  );
  const blocked =
    options.blockedPath === undefined ? [] : [options.blockedPath];
  const directories = [...new Set([...suggested, ...blocked])];
  const access = FILE_ACCESS[toolName] ?? "both";
  const fileSystem = {
    read: access === "write" ? [] : directories,
    write: access === "read" ? [] : directories,
  };
  const rules = suggestions.some((s) => s.type === "addRules");
  return {
    network:
      NETWORK_TOOLS.includes(toolName) || rules ? { enabled: true } : null,
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

export function approvalPayload(
  toolName: string,
  itemId: string,
  input: Input,
  reason: string | null,
  permissions: Permissions,
): ApprovalPayload {
  const plan = planSchema.safeParse(input).data;
  const bash = parseBashCommand(input);
  const path = input.file_path ?? input.path;
  const grantable = sessionUpdates(permissions, toolName) !== undefined;
  const availableDecisions: ApprovalPayload["availableDecisions"] =
    toolName !== PLAN_TOOL && grantable
      ? ["allow_once", "allow_for_session", "deny"]
      : ["allow_once", "deny"];
  const base = { kind: "approval" as const, reason, availableDecisions };
  const sessionGrant = permissions;
  if (toolName === PLAN_TOOL && plan !== undefined) {
    const planFilePath = plan.planFilePath ?? null;
    const subject = { kind: "plan" as const, itemId, plan: plan.plan };
    return { ...base, subject: { ...subject, planFilePath } };
  }
  if (toolName === "Bash" && bash !== undefined) {
    const actions = [{ type: "unknown" as const, command: bash.command }];
    const subject = { kind: "command" as const, itemId, ...bash, actions };
    return { ...base, subject: { ...subject, sessionGrant } };
  }
  if (FILE_ACCESS[toolName] === "write" && typeof path === "string" && path) {
    const subject = { kind: "file_change" as const, itemId, writeScope: null };
    return { ...base, subject: { ...subject, sessionGrant } };
  }
  const kind = "permission_grant" as const;
  return { ...base, subject: { kind, itemId, toolName, permissions } };
}

export function questionPayload(
  itemId: string,
  questions: z.infer<typeof questionSchema>[],
): QuestionPayload {
  return {
    kind: "user_question",
    questions: questions.map((question, index) => {
      const id = `${itemId}:question-${index + 1}`;
      return {
        id,
        prompt: question.question,
        shortLabel: question.header,
        multiSelect: question.multiSelect,
        options: question.options.map((option, optionIndex) => ({
          value: `${id}:option-${optionIndex + 1}`,
          label: option.label,
          description: option.description,
        })),
        allowFreeText: true,
      };
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
    if (chosen && typed !== undefined) {
      annotations[question.prompt] = { notes: typed };
    }
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

export function approvalResult(
  payload: ApprovalPayload,
  resolution: Resolution,
  input: Input,
): PermissionResult | undefined {
  if (!isApproval(resolution)) return undefined;
  const { subject } = payload;
  if (resolution.decision === "deny") {
    const message =
      subject.kind === "plan" ? PLAN_REJECTED : "Permission request denied";
    const decisionClassification = "user_reject";
    return { behavior: "deny", message, decisionClassification };
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
  const decisionClassification = "user_permanent";
  const session = { ...allowed, decisionClassification } as const;
  return updatedPermissions ? { ...session, updatedPermissions } : session;
}

function pathCovered(granted: string[], requested: string[]) {
  return requested.every((path) =>
    granted.some((grant) => {
      const [root, target] = [resolve(grant), resolve(path)];
      return target === root || target.startsWith(`${root}/`);
    }),
  );
}

function grantCovers(grant: Grant, toolName: string, wanted: Permissions) {
  const held = grant.permissions;
  const network = !wanted.network?.enabled || held.network?.enabled === true;
  const files = wanted.fileSystem;
  if (grant.toolName !== toolName || !network) return false;
  if (files === null || held.fileSystem === null) return files === null;
  const { read, write } = held.fileSystem;
  const readable = [...read, ...write];
  return pathCovered(readable, files.read) && pathCovered(write, files.write);
}

export class ClaudePermissions {
  private readonly grants: Grant[] = [];
  private readonly pending = new Set<(result: PermissionResult) => void>();

  constructor(private readonly host: PermissionHost) {}

  cancelPending(message: string) {
    const stopped = { behavior: "deny" as const, interrupt: true, message };
    for (const settle of [...this.pending]) settle(stopped);
  }

  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    await new Promise((settled) => setImmediate(settled));
    const toolUseID = options.toolUseID;
    const decided = await this.decide(toolName, input, options);
    return { ...decided, toolUseID };
  };

  private async decide(
    toolName: string,
    input: Input,
    options: Options,
  ): Promise<PermissionResult> {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const allow = { behavior: "allow" as const, updatedInput: input };
    const itemId = this.host.itemId(options.toolUseID);
    if (toolName === QUESTION_TOOL) {
      const parsed = questionsSchema.safeParse(input);
      if (!parsed.success) return deny("Invalid AskUserQuestion input");
      const payload = questionPayload(options.toolUseID, parsed.data.questions);
      const cancelled = "User question request cancelled";
      const resolution = await this.request(payload, options.signal, cancelled);
      if ("behavior" in resolution) return resolution;
      const updatedInput = answeredInput(payload, resolution);
      if (updatedInput === undefined) return deny(INVALID_RESPONSE);
      return { behavior: "allow", updatedInput };
    }
    const plan = toolName === PLAN_TOOL;
    if (plan && !planSchema.safeParse(input).success) {
      return deny("Invalid ExitPlanMode input");
    }
    const permissions = plan
      ? { network: null, fileSystem: null }
      : permissionProfile(toolName, options);
    const unattended = this.host.escalation() === "deny";
    const mode = this.host.mode();
    if (!plan) {
      const escaping = input.dangerouslyDisableSandbox === true;
      if (toolName === "Bash" && unattended && escaping) {
        return deny(WORKSPACE_DENIAL);
      }
      const granted = this.grants.some((grant) =>
        grantCovers(grant, toolName, permissions),
      );
      if (granted)
        return { ...allow, decisionClassification: "user_permanent" };
      const asks =
        options.blockedPath !== undefined ||
        options.decisionReason !== undefined ||
        (options.suggestions?.length ?? 0) > 0;
      if (!asks || mode === "bypassPermissions") return allow;
      const sandboxed = mode === "acceptEdits" || mode === "auto";
      const policy = sandboxed ? WORKSPACE_DENIAL : READONLY_DENIAL;
      if (unattended) return deny(options.decisionReason ?? policy);
    }
    const prompt = options.title ?? options.description ?? null;
    const reason = plan ? null : (options.decisionReason ?? prompt);
    const payload = approvalPayload(
      toolName,
      itemId,
      input,
      reason,
      permissions,
    );
    const cancelled = "Interactive request cancelled";
    const resolution = await this.request(payload, options.signal, cancelled);
    if ("behavior" in resolution) return resolution;
    const result = approvalResult(payload, resolution, input);
    if (result === undefined) return deny(INVALID_RESPONSE);
    const lasting =
      result.decisionClassification === "user_permanent" ||
      (result.behavior === "allow" && result.updatedPermissions !== undefined);
    if (lasting) this.grants.push({ toolName, permissions });
    if (plan && result.behavior === "allow") this.host.planApproved();
    return result;
  }

  private request(payload: Payload, signal: AbortSignal, cancelled: string) {
    return new Promise<Resolution | PermissionResult>((settle) => {
      const finish = (outcome: Resolution | PermissionResult) => {
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
