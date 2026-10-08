import type { ComponentType } from "react";
import { identified } from "../app-contracts.js";
import type {
  InteractionRenderer,
  MessageDirective,
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

export interface MessageAction {
  id: string;
  label: string;
  icon: string;
  order?: number;
  isAvailable?(message: TimelineMessage): boolean;
  run(message: TimelineMessage): void;
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

export const threadView = contract("thread-view", {
  api: service<ThreadViewApi>(),
  row: slot<TimelineRowRenderer>({ key: "kind" }),
  rowDetail: slot<TimelineRowDetailRenderer>({ key: "kind" }),
  pluginRow: slot<PluginRowRenderer>({ key: "kind" }),
  messageAction: slot<MessageAction>(),
  header: slot<ThreadHeaderItem>(),
  interaction: slot<InteractionRenderer>({ check: identified("view") }),
  messageDirective: slot<MessageDirective>({ check: identified("view") }),
});
