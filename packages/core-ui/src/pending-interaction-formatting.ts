import type {
  PendingInteractionApprovalDecision,
  PendingInteractionCommandAction,
  PendingInteractionGrantablePermissionProfile,
  PendingInteractionMacOsPermissions,
  PendingInteraction,
  PendingInteractionResolution,
  PendingInteractionRequestedPermissionProfile,
} from "@bb/domain";
import {
  isApprovalPendingInteractionPayload,
  isUserQuestionPendingInteractionPayload,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { describePendingInteractionToolUse } from "./pending-interaction-tool-use.js";

type PermissionProfile =
  | PendingInteractionGrantablePermissionProfile
  | PendingInteractionRequestedPermissionProfile;

function summarizeMacOsPermissions(
  permissions: PendingInteractionMacOsPermissions | null,
): string[] {
  if (permissions === null) return [];
  const { preferences, contacts, automations } = permissions;
  const appCount =
    typeof automations === "string" ? 0 : automations.bundleIds.length;
  return [
    permissions.accessibility ? "macOS accessibility" : null,
    permissions.launchServices ? "macOS launch services" : null,
    permissions.calendar ? "macOS calendar" : null,
    permissions.reminders ? "macOS reminders" : null,
    preferences !== "none"
      ? `macOS preferences (${preferences.replace("_", " ")})`
      : null,
    contacts !== "none"
      ? `macOS contacts (${contacts.replace("_", " ")})`
      : null,
    automations === "all"
      ? "macOS automation (all apps)"
      : appCount > 0
        ? `macOS automation (${appCount === 1 ? "1 app" : `${appCount} apps`})`
        : null,
  ].filter((summary) => summary !== null);
}

function summarizePermissions(permissions: PermissionProfile): string[] {
  const paths = (verb: string, list: readonly string[] | undefined) =>
    list && list.length > 0
      ? [list.length === 1 ? `${verb} 1 path` : `${verb} ${list.length} paths`]
      : [];
  return [
    ...(permissions.network?.enabled === true ? ["Network access"] : []),
    ...paths("Read", permissions.fileSystem?.read),
    ...paths("Write", permissions.fileSystem?.write),
    ...summarizeMacOsPermissions(
      "macos" in permissions ? permissions.macos : null,
    ),
  ];
}

function summarizeCommandAction(
  action: PendingInteractionCommandAction,
): string {
  switch (action.type) {
    case "read":
      return `Read ${action.path}`;
    case "listFiles":
      return action.path ? `List files in ${action.path}` : "List files";
    case "search":
      return action.query
        ? `Search for ${action.query}${action.path ? ` in ${action.path}` : ""}`
        : action.path
          ? `Search in ${action.path}`
          : "Search files";
    case "unknown":
      return action.command;
    default:
      return assertNever(action);
  }
}

function sessionGrantLines(
  permissions: PendingInteractionGrantablePermissionProfile | null,
): string[] {
  const summaries =
    permissions === null ? [] : summarizePermissions(permissions);
  return summaries.length > 0 ? [`Session grant: ${summaries.join(", ")}`] : [];
}

export function formatPendingInteractionSubjectDetailLines(
  interaction: PendingInteraction,
): string[] {
  const { payload } = interaction;
  if (isUserQuestionPendingInteractionPayload(payload)) {
    return payload.questions.map((question) => question.prompt);
  }
  if (!isApprovalPendingInteractionPayload(payload)) return [];
  const { subject } = payload;
  switch (subject.kind) {
    case "command":
      return [
        `Command: ${subject.command}`,
        ...(subject.cwd ? [`Cwd: ${subject.cwd}`] : []),
        ...subject.actions.map(
          (action) => `Action: ${summarizeCommandAction(action)}`,
        ),
        ...sessionGrantLines(subject.sessionGrant),
      ];
    case "file_change":
      return [
        `Item: ${subject.itemId}`,
        ...(subject.writeScope ? [`Write root: ${subject.writeScope}`] : []),
        ...sessionGrantLines(subject.sessionGrant),
      ];
    case "permission_grant":
      return [
        ...(subject.toolName ? [`Tool: ${subject.toolName}`] : []),
        ...summarizePermissions(subject.permissions).map(
          (permission) => `Permission: ${permission}`,
        ),
      ];
    case "plan":
      return subject.planFilePath ? [`Plan file: ${subject.planFilePath}`] : [];
    case "tool_use": {
      const ask = describePendingInteractionToolUse({ ...payload, subject });
      return [
        `Tool: ${ask.tool}`,
        ...(ask.headline !== null ? [ask.headline] : []),
        ...(ask.detail !== null ? [ask.detail] : []),
      ];
    }
    default:
      return assertNever(subject);
  }
}

export function buildPendingInteractionApprovalResolution(
  interaction: PendingInteraction,
  decision: PendingInteractionApprovalDecision,
): PendingInteractionResolution {
  if (decision === "deny") return { decision };
  const { payload } = interaction;
  if (!isApprovalPendingInteractionPayload(payload)) {
    return { decision, grantedPermissions: null };
  }
  const { subject } = payload;
  if (subject.kind === "permission_grant") {
    const { network, fileSystem } = subject.permissions;
    return {
      decision,
      grantedPermissions: {
        network: network?.enabled === true ? { enabled: true } : null,
        fileSystem: fileSystem
          ? { read: fileSystem.read, write: fileSystem.write }
          : null,
      },
    };
  }
  const grantsSession =
    decision === "allow_for_session" &&
    (subject.kind === "command" || subject.kind === "file_change");
  return {
    decision,
    grantedPermissions: grantsSession ? subject.sessionGrant : null,
  };
}
