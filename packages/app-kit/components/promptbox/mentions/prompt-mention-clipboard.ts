import {
  promptMentionResourceSchema,
  type PromptMentionResource,
} from "@bb/domain";
import { PLUGIN_MENTION_TRIGGER_VALUES } from "@bb/client-core";

const RESOURCE_ATTR = "data-prompt-mention-resource";
const SERIALIZED_TEXT_ATTR = "data-prompt-mention-serialized-text";

interface PromptMentionClipboardPayload {
  resource: PromptMentionResource;
  serializedText: string;
}

export function promptMentionClipboardDataAttributes(
  args: PromptMentionClipboardPayload,
) {
  return {
    "data-prompt-mention": "true",
    [RESOURCE_ATTR]: JSON.stringify(args.resource),
    [SERIALIZED_TEXT_ATTR]: args.serializedText,
  };
}

export function serializedTextForPromptMentionResource(
  resource: PromptMentionResource,
): string {
  switch (resource.kind) {
    case "thread":
      return `@thread:${resource.threadId}`;
    case "project":
      return `@project:${resource.projectId}`;
    case "section":
      return `@section:${resource.sectionId}`;
    case "command":
      return `${resource.trigger}${resource.name}`;
    case "plugin":
      return `@${resource.label}`;
    case "path": {
      const path =
        resource.source === "thread-storage"
          ? `thread-storage:${resource.path}`
          : resource.path;
      return `@${path}${
        resource.entryKind === "directory" && !path.endsWith("/") ? "/" : ""
      }`;
    }
  }
}

function parseResource(json: string): PromptMentionResource | null {
  try {
    return promptMentionResourceSchema.safeParse(JSON.parse(json)).data ?? null;
  } catch {
    return null;
  }
}

export function parsePromptMentionClipboardElement({
  element,
}: {
  element: Element;
}): PromptMentionClipboardPayload | null {
  const serializedText = element.getAttribute(SERIALIZED_TEXT_ATTR);
  const resourceJson = element.getAttribute(RESOURCE_ATTR);
  if (
    element.getAttribute("data-prompt-mention") !== "true" ||
    !serializedText ||
    !resourceJson
  ) {
    return null;
  }
  const resource = parseResource(resourceJson);
  if (resource === null) return null;
  if (resource.kind !== "plugin") {
    return {
      resource,
      serializedText: serializedTextForPromptMentionResource(resource),
    };
  }
  const { label } = resource;
  const valid = PLUGIN_MENTION_TRIGGER_VALUES.some((trigger) =>
    serializedText === label
      ? label.startsWith(trigger)
      : serializedText === `${trigger}${label}`,
  );
  return valid ? { resource, serializedText } : null;
}
