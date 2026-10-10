import type { KeyboardCommandId, Thread } from "@bb/domain";
import type { ComponentType } from "react";
import { contract, service, slot } from "./contract.js";
import { settings as serverSettings } from "./core-contracts.js";
import type * as T from "./app-types.js";

const ID = /^[a-zA-Z0-9_-]+$/u;

export function identified<Item extends { id: string }>(
  body: keyof Item & string,
) {
  return (item: Item, mine: readonly Item[]): string | null => {
    const { id } = item;
    if (typeof id !== "string" || !ID.test(id)) return `"id" must match ${ID}`;
    if (mine.some((other) => other.id === id)) return `duplicate id "${id}"`;
    return typeof item[body] === "function" ? null : `"${id}": missing ${body}`;
  };
}

export interface ShellRoute {
  id: string;
  path: string;
  view: ComponentType;
  order?: number;
}

export interface ShellNavContext {
  pathname: string;
  isHomeActive: boolean;
  isSettingsActive: boolean;
  homeRoutePath: string;
  settingsRoutePath: string;
  navigate(path: string): void;
}

export interface ShellNavItem {
  id: string;
  label: string;
  icon: string;
  position: "top" | "bottom";
  order?: number;
  command?: KeyboardCommandId;
  to?: string | ((context: ShellNavContext) => string);
  isActive?(context: ShellNavContext): boolean;
  run?(context: ShellNavContext): void;
}

export interface ThreadActionHandlers {
  requestArchive(thread: Thread): void;
  requestRename(thread: Thread): void;
  requestDelete(thread: Thread): void;
  unarchiveThread(thread: Thread): void;
  togglePin(thread: Thread): void;
  toggleRead(thread: Thread): void;
  renameThreadAsync(threadId: string, title: string): Promise<void>;
  sectionDestinations: readonly { label: string; sectionId: string | null }[];
  moveToSection(thread: Thread, sectionId: string | null): void;
}

export interface ThreadActionContext {
  thread: Thread;
  actions: ThreadActionHandlers;
}

export interface ThreadActionChoice {
  id: string;
  label: string;
  isCurrent?: boolean;
  run(): void | Promise<void>;
}

interface ThreadActionBase {
  id: string;
  label: string | ((context: ThreadActionContext) => string);
  icon: string | ((context: ThreadActionContext) => string);
  isAvailable?(context: ThreadActionContext): boolean;
  order?: number;
  group?: string;
  variant?: "default" | "destructive";
}

export type ThreadAction = ThreadActionBase &
  (
    | {
        run(context: ThreadActionContext): void | Promise<void>;
        choices?: undefined;
      }
    | {
        choices(context: ThreadActionContext): readonly ThreadActionChoice[];
        run?: undefined;
      }
  );

export interface SidebarFooterItem {
  id: string;
  label: string;
  icon: string;
  order?: number;
  run?(): void;
  view?: ComponentType;
}

export interface ShellApi {
  useSidebarThreads(options?: {
    lifecycles: readonly ("active" | "archived")[];
  }): T.SidebarThreadsState;
  useSidebarThreadActions(): T.SidebarThreadActions;
  useSidebarThreadSplit(threadId: string): T.SidebarSplit;
  useSidebarNavigationSplit(itemId: string): T.SidebarSplit;
  useSidebarThreadDraft(threadId: string): T.SidebarThreadDraftState;
  useSidebarThreadDraftIds(): ReadonlySet<string>;
  useSidebarThreadRowStatus(threadId: string): T.ThreadRowStatus | null;
  useSidebarThreadRowStatuses(): ReadonlyMap<string, T.ThreadRowStatus>;
  useSidebarSplitLayout(): T.SidebarSplitLayout | null;
  useSidebarThreadShortcut(threadId: string): T.ShortcutHint | null;
  useSidebarNavigation(): T.SidebarNavigationState;
  SidebarNavigationIcon: ComponentType<T.SidebarNavigationIconProps>;
}

export interface PartsBag {
  plugin: string;
  parts: Readonly<Record<string, unknown>>;
}

export const app = contract("app", {
  root: service<ComponentType>(),
  icon: slot<T.AppIcon>({ key: "name" }),
  parts: slot<PartsBag>({ key: "plugin" }),
});

export const shell = contract("shell", {
  api: service<ShellApi>(),
  route: slot<ShellRoute>({ key: "id" }),
  navItem: slot<ShellNavItem>({ key: "id" }),
  navPanel: slot<T.ShellNavPanel>({ check: identified("view") }),
  overlay: slot<T.ShellOverlay>({ check: identified("view") }),
  command: slot<T.ShellCommand>({ check: identified("run") }),
  threadAction: slot<ThreadAction>({ key: "id" }),
  threadList: slot<T.ShellProvider<T.ShellThreadListProps>>({
    check: identified("view"),
  }),
  sidebarFooter: slot<SidebarFooterItem>(),
  threadRowStatus: slot<T.ThreadRowStatusEntry>(),
});

export interface SettingsPage {
  id: string;
  label: string;
  icon: string;
  order?: number;
  group?: "main" | "archived";
  view: ComponentType;
}

export const settings = contract("settings", {
  ...serverSettings,
  page: slot<SettingsPage>({ key: "id" }),
  section: slot<T.SettingsPageSection>({ check: identified("view") }),
});
