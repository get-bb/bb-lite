import type { ComponentType } from "react";
import { identified } from "../app-contracts.js";
import type {
  CodeFenceRenderer,
  InteractionRenderer,
  MessageDirective,
  TargetedPanelOpenOptions,
  ThreadChatProps,
} from "../app-types.js";
import { contract, service, slot } from "../contract.js";

export interface TimelineRowData {
  readonly id: string;
  readonly kind: string;
}

export interface TimelineRowProps {
  row: TimelineRowData;
  compactActivityIntents: boolean;
  forceExpanded: boolean;
  isLatestBundle: boolean;
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: "top-level" | "nested" | "bundle";
}

export interface TimelineRowRenderer {
  kind: string;
  view: ComponentType<TimelineRowProps>;
}

export interface TimelineRowDetailProps {
  row: TimelineRowData;
}

export interface TimelineRowDetailRenderer {
  kind: string;
  view: ComponentType<TimelineRowDetailProps>;
}

export interface PluginRowProps {
  row: TimelineRowData;
  title: string;
  detail: string | null;
  status: "pending" | "completed" | "error" | "interrupted" | null;
  data: unknown;
}

export interface PluginRowRenderer {
  kind: string;
  view: ComponentType<PluginRowProps>;
}

export interface TimelineMessage {
  threadId: string | null;
  role: "user" | "assistant";
  text: string;
}

export interface MessageActionContext extends TimelineMessage {
  selectedText: string | null;
  seq: number | null;
  openPanel(options: TargetedPanelOpenOptions): boolean;
}

export interface MessageAction {
  id: string;
  label: string;
  icon: string;
  order?: number;
  isAvailable?(message: TimelineMessage): boolean;
  run(context: MessageActionContext): void;
}

export interface ThreadHeaderItem {
  id: string;
  order?: number;
  view: ComponentType<{ threadId: string }>;
}

export interface ThreadViewApi {
  ThreadChat: ComponentType<ThreadChatProps>;
  ThreadTitle: ComponentType<{ threadId: string }>;
}

const CODE_FENCE_LANGUAGE = /^[a-z0-9][a-z0-9+#._-]*$/u;
const hasView = identified<CodeFenceRenderer>("view");

function codeFenceCheck(
  item: CodeFenceRenderer,
  mine: readonly CodeFenceRenderer[],
): string | null {
  const refused = hasView(item, mine);
  if (refused !== null) return refused;
  const { id, languages } = item;
  if (!Array.isArray(languages) || languages.length === 0) {
    return `"${id}": "languages" must list at least one language`;
  }
  const claimed = new Set(mine.flatMap((other) => other.languages));
  for (const language of languages) {
    if (typeof language !== "string" || !CODE_FENCE_LANGUAGE.test(language)) {
      return `"${id}": language ${JSON.stringify(language)} must match ${CODE_FENCE_LANGUAGE}`;
    }
    if (claimed.has(language)) {
      return `"${id}": language "${language}" is claimed twice`;
    }
    claimed.add(language);
  }
  return null;
}

export const threadView = contract("threadView", {
  api: service<ThreadViewApi>(),
  row: slot<TimelineRowRenderer>({ key: "kind" }),
  rowDetail: slot<TimelineRowDetailRenderer>({ key: "kind" }),
  pluginRow: slot<PluginRowRenderer>({ key: "kind" }),
  messageAction: slot<MessageAction>(),
  header: slot<ThreadHeaderItem>(),
  interaction: slot<InteractionRenderer>({ check: identified("view") }),
  messageDirective: slot<MessageDirective>({ check: identified("view") }),
  codeFence: slot<CodeFenceRenderer>({ check: codeFenceCheck }),
});
