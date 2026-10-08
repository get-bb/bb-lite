import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  pendingInteractionCommandActionSchema as commandActionSchema,
  reasoningEffortsForLevels,
  reasoningLevelSchema,
  type AvailableModel,
  type PendingInteractionApprovalDecision as Decision,
  type PendingInteractionPayload,
  type PendingInteractionResolution,
  type PromptInput,
} from "@bb/domain";
import { z } from "zod";
import { RunnerError, type ExecutionOptions } from "@bb/runner";

export const POOL_URL = "CODEX_OPENAI_BASE_URL";
export const POOL_TOKEN = "CODEX_POOL_AUTH_TOKEN";
const PERMISSIONS_REQUEST = "item/permissions/requestApproval";
const FILE_CHANGE_REQUEST = "item/fileChange/requestApproval";
const DECISIONS: Record<string, Decision> = {
  accept: "allow_once",
  acceptForSession: "allow_for_session",
  decline: "deny",
  cancel: "deny",
};
const ENCODED = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} as const;

const text = z.string();
const paths = z.array(text).nullable();
const fileSystemSchema = z
  .object({ read: paths, write: paths })
  .transform(({ read, write }) => ({ read: read ?? [], write: write ?? [] }));
const permissionsSchema = z.object({
  network: z.object({ enabled: z.boolean().nullable() }).nullish(),
  fileSystem: fileSystemSchema.nullish(),
});
export const approvalSchema = z.object({
  turnId: text,
  itemId: text,
  reason: text.nullish(),
  command: text.nullish(),
  cwd: text.nullish(),
  commandActions: z.array(z.unknown()).nullish(),
  additionalPermissions: permissionsSchema.nullish(),
  availableDecisions: z.array(z.unknown()).nullish(),
  grantRoot: text.nullish(),
  permissions: permissionsSchema.optional(),
});
export const providerOptionsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  providerSubagentsEnabled: z.boolean().optional(),
  additionalWorkspaceWriteRoots: z.array(text).optional(),
});
const effortSchema = z.object({ reasoningEffort: reasoningLevelSchema });
const modelSchema = z.object({
  id: text.min(1),
  model: text.min(1),
  displayName: text.min(1).optional(),
  description: text.optional(),
  supportedReasoningEfforts: z.array(z.unknown()).optional(),
  defaultReasoningEffort: z.unknown().optional(),
  isDefault: z.boolean().optional(),
});

export function poolArgs(env: Record<string, string>) {
  const url = env[POOL_URL];
  if (!url || !env[POOL_TOKEN]) return [];
  const provider = "model_providers.bb-account-pool";
  const overrides = [
    `openai_base_url=${JSON.stringify(url)}`,
    'model_provider="bb-account-pool"',
    `${provider}.name="OpenAI"`,
    `${provider}.base_url=${JSON.stringify(url)}`,
    `${provider}.wire_api="responses"`,
    `${provider}.requires_openai_auth=true`,
    `${provider}.supports_websockets=false`,
    `${provider}.env_http_headers.x-bb-account-pool-token="${POOL_TOKEN}"`,
  ];
  return overrides.flatMap((override) => ["-c", override]);
}

export function permissionSettings(options: ExecutionOptions) {
  if (options.permissionMode === "full") {
    const sandbox = "danger-full-access";
    return { approvalPolicy: "never", approvalsReviewer: "user", sandbox };
  }
  const automatic = options.permissionMode === "auto";
  const unattended = options.permissionEscalation === "deny" && !automatic;
  const approvalPolicy = unattended ? "never" : "on-request";
  const approvalsReviewer = automatic ? "auto_review" : "user";
  return { approvalPolicy, approvalsReviewer, sandbox: "workspace-write" };
}

export function sandboxPolicy(options: ExecutionOptions, roots: string[]) {
  if (options.permissionMode === "full") return { type: "dangerFullAccess" };
  const access = { writableRoots: roots, networkAccess: true };
  const tmp = { excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { type: "workspaceWrite", ...access, ...tmp };
}

export function reasoningEffort(options: ExecutionOptions) {
  const level = options.reasoningLevel;
  if (level !== "none" && level !== "ultracode") return level;
  const message = `Codex does not support the ${level} reasoning level.`;
  throw new RunnerError("failed", message);
}

export function serviceTier(options: ExecutionOptions) {
  return options.serviceTier === "fast" ? "fast" : null;
}

export function toCodexInput(input: PromptInput[]) {
  return input.map((chunk) => {
    if (chunk.type === "image") return { type: chunk.type, url: chunk.url };
    if (chunk.type === "text" || chunk.type === "localFile") {
      const attached = "path" in chunk ? `[Attached file: ${chunk.path}]` : "";
      const body = chunk.type === "text" ? chunk.text : attached;
      return { type: "text", text: body, text_elements: [] };
    }
    return { type: chunk.type, path: chunk.path };
  });
}

export async function gitWritableRoots(cwd: string): Promise<string[]> {
  try {
    const workspace = await realpath(cwd);
    const gitFile = join(workspace, ".git");
    const read = async (path: string) => (await readFile(path, "utf8")).trim();
    const pointer = /^gitdir:\s*(.+)$/m.exec(await read(gitFile))?.[1]?.trim();
    if (!pointer) return [];
    const gitDir = await realpath(resolve(workspace, pointer));
    const backlink = resolve(gitDir, await read(join(gitDir, "gitdir")));
    const commonPointer = await read(join(gitDir, "commondir"));
    const common = await realpath(resolve(gitDir, commonPointer));
    const linked = gitDir.startsWith(join(common, "worktrees") + sep);
    if (backlink !== gitFile || !linked) return [];
    const head = await read(join(gitDir, "HEAD"));
    const ref = /^ref:\s*(refs\/[\w./-]+)$/.exec(head)?.[1];
    const refDir = ref && !ref.includes("..") ? dirname(ref) : "refs/heads";
    const candidates = ["objects", refDir, join("logs", refDir)];
    const existing = (path: string) =>
      realpath(join(common, path)).catch(() => "");
    const resolved = await Promise.all(candidates.map(existing));
    const inside = resolved.filter((path) => path.startsWith(common + sep));
    return [gitDir, ...inside];
  } catch {
    return [];
  }
}

export function decodeApproval(
  method: string,
  params: unknown,
): PendingInteractionPayload {
  const request = approvalSchema.parse(params);
  const { itemId } = request;
  const base = { kind: "approval" as const, reason: request.reason ?? null };
  const every: Decision[] = ["allow_once", "allow_for_session", "deny"];
  const profile = (grant: z.infer<typeof permissionsSchema> | null = null) => {
    const network = grant?.network ?? null;
    const fileSystem = grant?.fileSystem ?? null;
    return { network, fileSystem };
  };
  const once = (decision: Decision) => decision !== "allow_for_session";
  if (method === PERMISSIONS_REQUEST) {
    const permissions = profile(request.permissions);
    const grant = { kind: "permission_grant" as const, itemId, permissions };
    const subject = { ...grant, toolName: null };
    return { ...base, subject, availableDecisions: every };
  }
  if (method === FILE_CHANGE_REQUEST) {
    const writeScope = request.grantRoot || null;
    const fileSystem = { read: [], write: writeScope ? [writeScope] : [] };
    const sessionGrant = writeScope ? { network: null, fileSystem } : null;
    const change = { kind: "file_change" as const, itemId, writeScope };
    const availableDecisions = writeScope ? every : every.filter(once);
    const subject = { ...change, sessionGrant };
    return { ...base, subject, availableDecisions };
  }
  const { command } = request;
  if (!command) throw new Error("Command approval request has no command");
  const grant = profile(request.additionalPermissions);
  const files = [grant.fileSystem?.read, grant.fileSystem?.write].flat();
  const grantable = grant.network?.enabled === true || files.some(Boolean);
  const offered = request.availableDecisions?.flatMap((decision) => {
    const known = typeof decision === "string" ? DECISIONS[decision] : null;
    return known ? [known] : [];
  });
  const decisions = [...new Set(offered ?? every)];
  const availableDecisions = grantable ? decisions : decisions.filter(once);
  if (availableDecisions.length === 0) {
    throw new Error("Command approval request offers no usable decision");
  }
  const actions = (request.commandActions ?? []).flatMap((action) => {
    const parsed = commandActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
  const cwd = request.cwd ?? null;
  const run = { kind: "command" as const, itemId, command, cwd, actions };
  const subject = { ...run, sessionGrant: grantable ? grant : null };
  return { ...base, subject, availableDecisions };
}

export function encodeApproval(
  method: string,
  resolution: PendingInteractionResolution,
) {
  const decision = "decision" in resolution ? resolution.decision : "deny";
  if (method !== PERMISSIONS_REQUEST) return { decision: ENCODED[decision] };
  const granted =
    "grantedPermissions" in resolution ? resolution.grantedPermissions : null;
  if (decision === "deny" || !granted)
    return { permissions: {}, scope: "turn" };
  const list = (entries: string[]) => (entries.length > 0 ? entries : null);
  const { network, fileSystem: files } = granted;
  const access = files && { read: list(files.read), write: list(files.write) };
  const permissions = {
    ...(network ? { network: { enabled: network.enabled } } : {}),
    ...(access ? { fileSystem: access } : {}),
  };
  const scope = decision === "allow_for_session" ? "session" : "turn";
  return { permissions, scope };
}

export function parseModels(result: unknown): AvailableModel[] {
  const { data } = z.object({ data: z.array(z.unknown()) }).parse(result);
  const defaults = ["low", "medium", "high", "xhigh"] as const;
  return data.flatMap((entry) => {
    const parsed = modelSchema.safeParse(entry);
    if (!parsed.success) return [];
    const { id, model, displayName, description, ...raw } = parsed.data;
    const levels = (raw.supportedReasoningEfforts ?? []).flatMap((effort) => {
      const known = effortSchema.safeParse(effort);
      return known.success ? [known.data.reasoningEffort] : [];
    });
    const supported = levels.length > 0 ? [...new Set(levels)] : [...defaults];
    const stated = raw.defaultReasoningEffort;
    const preferred = reasoningLevelSchema.safeParse(stated);
    const usable = preferred.success && supported.includes(preferred.data);
    const available: AvailableModel = {
      id,
      model,
      displayName: displayName ?? model,
      description: description ?? "",
      supportedReasoningEfforts: reasoningEffortsForLevels(supported),
      defaultReasoningEffort: usable ? preferred.data : supported[0],
      isDefault: raw.isDefault === true,
    };
    return [available];
  });
}
