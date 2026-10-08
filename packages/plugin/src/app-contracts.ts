import type { KeyboardCommandId, Thread } from "@bb/domain";
import type { ComponentType } from "react";
import { contract, slot } from "./contract.js";
import type * as T from "./app-types.js";

export type Owned<Registration> = Registration & {
  pluginId: string;
  generation: number;
};

type ComponentSlot<Props> = Owned<T.PluginComponentRegistration<Props>>;
type ProviderSlot<Props> = Owned<T.PluginProviderRegistration<Props>>;

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

export const shell = contract("shell", {
  navPanel: slot<Owned<T.PluginNavPanelRegistration>>(),
  threadPanel: slot<Owned<T.PluginThreadPanelRegistration>>(),
  settingsSection: slot<Owned<T.PluginSettingsSectionRegistration>>(),
  appOverlay: slot<Owned<T.PluginComponentRegistration>>(),
  pendingInteraction: slot<ComponentSlot<T.PluginPendingInteractionProps>>(),
  messageDirective: slot<ComponentSlot<T.PluginMessageDirectiveProps>>(),
  threadList: slot<ProviderSlot<T.PluginThreadListProps>>(),
  sidebarNavigation: slot<ProviderSlot<T.SidebarNavigationProps>>(),
  sidebarHeader: slot<ProviderSlot<T.SidebarHeaderProps>>(),
  command: slot<Owned<T.PluginCommandRegistration>>(),
  route: slot<ShellRoute>({ key: "id" }),
  navItem: slot<ShellNavItem>({ key: "id" }),
  threadAction: slot<ThreadAction>({ key: "id" }),
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
  page: slot<SettingsPage>({ key: "id" }),
});
