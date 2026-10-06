import type { ComponentType, ReactElement } from "react";
import type { BbSdkAreas } from "@bb/sdk";
import type * as T from "./app-types.js";

export type * from "./app-types.js";
export * from "./shared-modules.js";

export interface PluginAppApi {
  slots: {
    navPanel(registration: T.PluginNavPanelRegistration): void;
    threadPanel(registration: T.PluginThreadPanelRegistration): void;
    settingsSection(registration: T.PluginSettingsSectionRegistration): void;
    appOverlay(registration: T.PluginComponentRegistration): void;
    pendingInteraction(
      registration: T.PluginComponentRegistration<T.PluginPendingInteractionProps>,
    ): void;
    messageDirective(
      registration: T.PluginComponentRegistration<T.PluginMessageDirectiveProps>,
    ): void;
    threadList(
      registration: T.PluginProviderRegistration<T.PluginThreadListProps>,
    ): void;
    sidebarNavigation(
      registration: T.PluginProviderRegistration<T.SidebarNavigationProps>,
    ): void;
    sidebarHeader(
      registration: T.PluginProviderRegistration<T.SidebarHeaderProps>,
    ): void;
  };
  commands: { register(registration: T.PluginCommandRegistration): void };
}

export interface PluginAppDefinition {
  readonly __bbPluginApp: true;
  readonly setup: (app: PluginAppApi) => void;
}

export function definePluginApp(
  setup: PluginAppDefinition["setup"],
): PluginAppDefinition {
  if (typeof setup !== "function") {
    throw new Error("definePluginApp expects a setup function");
  }
  return Object.freeze({ __bbPluginApp: true as const, setup });
}

export interface PluginAppHost {
  createElement<Props extends object>(
    type: ComponentType<Props>,
    props: Props,
  ): ReactElement;
  useRpc<
    Contract extends T.PluginRpcContract = T.PluginRpcContract,
  >(): T.PluginRpcClient<Contract>;
  useRealtime(channel: string, handler: (payload: unknown) => void): void;
  useRealtimeConnectionState(): T.PluginRealtimeConnectionState;
  useSettings(): T.PluginSettingsState;
  useSdk(): BbSdkAreas;
  usePluginId(): string;
  useBbContext(): T.BbContext;
  useBbNavigate(): T.BbNavigate;
  useSidebarThreads(options?: {
    lifecycles: readonly ("active" | "archived")[];
  }): T.PluginSidebarThreadsState;
  useSidebarThreadActions(): T.PluginSidebarThreadActions;
  useSidebarThreadSplit(threadId: string): T.PluginSidebarThreadSplit;
  useSidebarThreadDraft(threadId: string): T.PluginSidebarThreadDraftState;
  useSidebarThreadDraftIds(): ReadonlySet<string>;
  useSidebarThreadRowStatus(
    threadId: string,
  ): T.PluginSidebarThreadRowStatus | null;
  useSidebarThreadRowStatuses(): ReadonlyMap<
    string,
    T.PluginSidebarThreadRowStatus
  >;
  useSidebarSplitLayout(): T.PluginSidebarSplitLayout | null;
  useSidebarThreadShortcut(threadId: string): T.ShortcutHint | null;
  useProviders(): T.PluginProvidersState;
  useEnvironmentProviders(): T.PluginEnvironmentProvidersState;
  useSidebarNavigation(): T.SidebarNavigationState;
  useQuestionFormHost(): T.QuestionFormHost;
  SidebarNavigationIcon: ComponentType<T.SidebarNavigationIconProps>;
  ThreadChat: ComponentType<T.ThreadChatProps>;
  Icon: ComponentType<T.IconProps>;
  ProviderIcon: ComponentType<T.ProviderIconProps>;
  UrlLink: ComponentType<T.UrlLinkProps>;
  ThreadTitle: ComponentType<{ threadId: string }>;
}

let installedHost: PluginAppHost | null = null;

export function installPluginAppHost(host: PluginAppHost): void {
  installedHost = host;
}

function host(): PluginAppHost {
  if (installedHost === null) {
    throw new Error("@bb/plugin/app was used before the bb app installed it");
  }
  return installedHost;
}

function hook<Name extends keyof PluginAppHost>(
  name: Name,
): PluginAppHost[Name] {
  const forward = (...args: unknown[]) =>
    (host()[name] as (...args: unknown[]) => unknown)(...args);
  return forward as PluginAppHost[Name];
}

function component<Props extends object>(
  pick: (host: PluginAppHost) => ComponentType<Props>,
): ComponentType<Props> {
  return (props: Props) => host().createElement(pick(host()), props);
}

export const useRpc = hook("useRpc");
export const useRealtime = hook("useRealtime");
export const useRealtimeConnectionState = hook("useRealtimeConnectionState");
export const useSettings = hook("useSettings");
export const useSdk = hook("useSdk");
export const usePluginId = hook("usePluginId");
export const useBbContext = hook("useBbContext");
export const useBbNavigate = hook("useBbNavigate");
export const useSidebarThreads = hook("useSidebarThreads");
export const useSidebarThreadActions = hook("useSidebarThreadActions");
export const useSidebarThreadSplit = hook("useSidebarThreadSplit");
export const useSidebarThreadDraft = hook("useSidebarThreadDraft");
export const useSidebarThreadDraftIds = hook("useSidebarThreadDraftIds");
export const useSidebarThreadRowStatus = hook("useSidebarThreadRowStatus");
export const useSidebarThreadRowStatuses = hook("useSidebarThreadRowStatuses");
export const useSidebarSplitLayout = hook("useSidebarSplitLayout");
export const useSidebarThreadShortcut = hook("useSidebarThreadShortcut");
export const useProviders = hook("useProviders");
export const useEnvironmentProviders = hook("useEnvironmentProviders");
export const useSidebarNavigation = hook("useSidebarNavigation");
export const useQuestionFormHost = hook("useQuestionFormHost");
export const SidebarNavigationIcon = component((h) => h.SidebarNavigationIcon);
export const ThreadChat = component((h) => h.ThreadChat);
export const Icon = component((h) => h.Icon);
export const ProviderIcon = component((h) => h.ProviderIcon);
export const UrlLink = component((h) => h.UrlLink);
export const ThreadTitle = component((h) => h.ThreadTitle);
