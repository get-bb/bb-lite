import type { ComponentType } from "react";
import { contract, slot } from "../contract.js";

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

export const threadView = contract("thread-view", {
  row: slot<TimelineRowRenderer>({ key: "kind" }),
  rowDetail: slot<TimelineRowDetailRenderer>({ key: "kind" }),
  pluginRow: slot<PluginRowRenderer>({ key: "kind" }),
  messageAction: slot<MessageAction>(),
});
