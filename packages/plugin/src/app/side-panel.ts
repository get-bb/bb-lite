import type { ComponentType } from "react";
import type { ThreadTab } from "@bb/server-contract";
import { contract, slot } from "../contract.js";

export type SidePanelTab = ThreadTab;

export interface SidePanelTabProps {
  tab: SidePanelTab;
  threadId: string;
  projectId: string;
  environmentId: string | null;
  workspaceRootPath: string | null;
  isPanelOpen: boolean;
}

export interface SidePanelTabIconProps {
  tab: SidePanelTab;
}

export interface SidePanelTabKind {
  kind: string;
  view: ComponentType<SidePanelTabProps>;
  icon?: ComponentType<SidePanelTabIconProps>;
  title?: (tab: SidePanelTab) => string;
}

export const sidePanel = contract("side-panel", {
  tab: slot<SidePanelTabKind>({ key: "kind" }),
});
