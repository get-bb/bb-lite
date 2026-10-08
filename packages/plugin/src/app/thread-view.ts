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

export const threadView = contract("thread-view", {
  row: slot<TimelineRowRenderer>({ key: "kind" }),
  rowDetail: slot<TimelineRowDetailRenderer>({ key: "kind" }),
});
