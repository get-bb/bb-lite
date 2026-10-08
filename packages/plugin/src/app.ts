import type { ComponentType, ReactElement } from "react";
import type { BbSdkAreas } from "@bb/sdk";
import type { z } from "zod";
import type * as T from "./app-types.js";
import type { ComposerHandle } from "./app/composer.js";
import type { Live, Op, Slot } from "./contract.js";
import type { PluginVerbs, SlotEntryView } from "./kernel.js";

export type * from "./app-types.js";
export * from "./app-contracts.js";
export * from "./app/composer.js";
export * from "./app/side-panel.js";
export * from "./app/thread-view.js";
export * from "./contract.js";
export { createKernel, deny, OpError } from "./kernel.js";
export type * from "./kernel.js";
export * from "./shared-modules.js";

export interface OpState<Output> {
  status: "loading" | "ready" | "error";
  data: Output | undefined;
  error: Error | null;
  refetch(): void;
}

type OpInput<O extends Op> = z.input<O["input"]>;
type OpOutput<O extends Op> = z.output<O["output"]>;

export interface PluginAppApi extends PluginVerbs {
  readonly pluginId: string;
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
  onMount(run: (context: { signal: AbortSignal }) => void | (() => void)): void;
  setThreadRowStatus(
    threadId: string,
    status: T.PluginSidebarThreadRowStatus | null,
  ): void;
  icons: {
    register(
      icons: Record<string, ComponentType<{ className?: string }>>,
    ): void;
  };
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

export const plugin = definePluginApp;

export interface PluginAppHost {
  createElement<Props extends object>(
    type: ComponentType<Props>,
    props: Props,
  ): ReactElement;
  useRealtimeConnectionState(): T.PluginRealtimeConnectionState;
  useSettings(): T.PluginSettingsState;
  useSdk(): BbSdkAreas;
  useComposer(): ComposerHandle | null;
  useComposers(): readonly ComposerHandle[];
  usePluginId(): string;
  useBbContext(): T.BbContext;
  useBbNavigate(): T.BbNavigate;
  useSidebarThreads(options?: {
    lifecycles: readonly ("active" | "archived")[];
  }): T.PluginSidebarThreadsState;
  useSidebarThreadActions(): T.PluginSidebarThreadActions;
  useSidebarThreadSplit(threadId: string): T.PluginSidebarThreadSplit;
  useSidebarNavigationSplit(itemId: string): T.PluginSidebarThreadSplit;
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
  useSlot<Item>(slot: Slot<Item>): readonly Item[];
  useSlotEntries<Item>(slot: Slot<Item>): readonly SlotEntryView<Item>[];
  useSlotEntry<Item>(slot: Slot<Item>, key: string): Item | null;
  useOp<O extends Op>(
    op: O,
    input: OpInput<O>,
    options?: { enabled?: boolean },
  ): OpState<OpOutput<O>>;
  useCall<O extends Op>(op: O): (input: OpInput<O>) => Promise<OpOutput<O>>;
  useLive<L extends Live>(live: L): z.output<L["value"]> | undefined;
  useChanged(member: Op | Live, handler: () => void): void;
  callOp<O extends Op>(op: O, input: OpInput<O>): Promise<OpOutput<O>>;
  SlotMount: ComponentType<T.SlotMountProps>;
  SidebarNavigationIcon: ComponentType<T.SidebarNavigationIconProps>;
  ThreadChat: ComponentType<T.ThreadChatProps>;
  Icon: ComponentType<T.IconProps>;
  ProviderIcon: ComponentType<T.ProviderIconProps>;
  UrlLink: ComponentType<T.UrlLinkProps>;
  ThreadTitle: ComponentType<{ threadId: string }>;
  ThreadViewers: ComponentType<T.ThreadViewersProps>;
  ImageLightbox: ComponentType<T.ImageLightboxProps>;
  Markdown: ComponentType<T.MarkdownProps>;
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

export const useRealtimeConnectionState = hook("useRealtimeConnectionState");
export const useSettings = hook("useSettings");
export const useSdk = hook("useSdk");
export const useComposer = hook("useComposer");
export const useComposers = hook("useComposers");
export const usePluginId = hook("usePluginId");
export const useBbContext = hook("useBbContext");
export const useBbNavigate = hook("useBbNavigate");
export const useSidebarThreads = hook("useSidebarThreads");
export const useSidebarThreadActions = hook("useSidebarThreadActions");
export const useSidebarThreadSplit = hook("useSidebarThreadSplit");
export const useSidebarNavigationSplit = hook("useSidebarNavigationSplit");
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
export const useSlot = hook("useSlot");
export const useSlotEntries = hook("useSlotEntries");
export const useSlotEntry = hook("useSlotEntry");
export const useOp = hook("useOp");
export const useCall = hook("useCall");
export const useLive = hook("useLive");
export const useChanged = hook("useChanged");
export const callOp = hook("callOp");
export const SlotMount = component((h) => h.SlotMount);
export const SidebarNavigationIcon = component((h) => h.SidebarNavigationIcon);
export const ThreadChat = component((h) => h.ThreadChat);
export const Icon = component((h) => h.Icon);
export const ProviderIcon = component((h) => h.ProviderIcon);
export const UrlLink = component((h) => h.UrlLink);
export const ThreadTitle = component((h) => h.ThreadTitle);
export const ThreadViewers = component((h) => h.ThreadViewers);
export const ImageLightbox = component((h) => h.ImageLightbox);
export const Markdown = component((h) => h.Markdown);
