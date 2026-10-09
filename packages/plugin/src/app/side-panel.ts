import type { ComponentType } from "react";
import type { ThreadTab } from "@bb/server-contract";
import { identified } from "../app-contracts.js";
import type { FileSource, SidePanelPanel } from "../app-types.js";
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

export interface FileViewerProps {
  path: string;
  threadId: string | null;
  source: FileSource;
  name: string;
  url: string | null;
  mimeType: string | null;
  content: string | null;
  refresh(): void;
}

export interface FileViewer {
  id: string;
  extensions: readonly string[];
  names?: readonly string[];
  view: ComponentType<FileViewerProps>;
}

export const sidePanel = contract("sidePanel", {
  tab: slot<SidePanelTabKind>({ key: "kind" }),
  fileViewer: slot<FileViewer>(),
  panel: slot<SidePanelPanel>({ check: identified("view") }),
});
