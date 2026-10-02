import type { PromptMentionResource } from "@bb/domain";
import type { IconName } from "@bb/shared-ui/icon";

export const PROMPT_MENTION_PILL_CLASS =
  "prompt-mention-pill inline-flex max-w-full items-baseline gap-0.5 rounded-full border py-0.5 pl-1 pr-1.5 text-xs leading-4 align-baseline";

function describeMention(resource: PromptMentionResource): [string, IconName] {
  switch (resource.kind) {
    case "thread":
      return ["Thread", "UserRound"];
    case "project":
      return ["Project", "Folder"];
    case "section":
      return ["Section", "SectionAdd"];
    case "command":
      return [
        resource.source === "skill" ? "Skill" : "Command",
        promptCommandIconName(resource),
      ];
    case "plugin":
      return ["Plugin", "Zap"];
    case "path": {
      const isDirectory = resource.entryKind === "directory";
      return [
        resource.source === "thread-storage"
          ? "Storage"
          : isDirectory
            ? "Folder"
            : "File",
        isDirectory ? "Folder" : "File",
      ];
    }
  }
}

export function promptMentionIconName(
  resource: PromptMentionResource,
): IconName {
  return describeMention(resource)[1];
}

export function promptCommandIconName(command: {
  name: string;
  source: Extract<PromptMentionResource, { kind: "command" }>["source"];
}): IconName {
  return command.source === "skill"
    ? "Zap"
    : command.name === "plan"
      ? "ListTodo"
      : "Terminal";
}

export function promptMentionDisplayLabel(
  resource: PromptMentionResource,
): string {
  return `${describeMention(resource)[0]}: ${resource.label}`;
}

export function promptMentionTooltipLabel(
  resource: PromptMentionResource,
): string {
  if (resource.kind === "path") {
    return resource.source === "thread-storage"
      ? `thread-storage:${resource.path}`
      : resource.path;
  }
  if (resource.kind === "command") {
    return `${resource.trigger}${resource.name}${resource.argumentHint ? ` ${resource.argumentHint}` : ""}`;
  }
  return promptMentionDisplayLabel(resource);
}
