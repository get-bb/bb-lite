import type { ComponentType, ReactElement } from "react";
import type { z } from "zod";
import { shell } from "./app-contracts.js";
import type * as T from "./app-types.js";
import { composer } from "./app/composer.js";
import { threadView } from "./app/thread-view.js";
import type { PluginBase } from "./base.js";
import type { RemoteCallOptions } from "./client.js";
import type { Live, Op, Slot } from "./contract.js";
import type { KernelDescription } from "./describe.js";
import type { SlotEntryView } from "./kernel.js";

export type * from "./app-types.js";
export type * from "./base.js";
export * from "./app-contracts.js";
export { settings } from "./app-contracts.js";
export * from "./client.js";
export * from "./app/composer.js";
export * from "./app/side-panel.js";
export * from "./app/thread-view.js";
export * from "./contract.js";
export * from "./core-contracts.js";
export { describeKernel, type KernelDescription } from "./describe.js";
export { createKernel, deny, fail, OpError } from "./kernel.js";
export type * from "./kernel.js";
export * from "./shared-modules.js";
export * from "./version.js";

export interface OpState<Output> {
  status: "loading" | "ready" | "error";
  data: Output | undefined;
  error: Error | null;
  refetch(): void;
}

type OpInput<O extends Op> = z.input<O["input"]>;
type OpOutput<O extends Op> = z.output<O["output"]>;

export type PluginAppApi = PluginBase;

export type PluginAppEntry = (bb: PluginAppApi) => void;

export interface PluginAppHost {
  createElement<Props extends object>(
    type: ComponentType<Props>,
    props: Props,
  ): ReactElement;
  use<Item>(slot: Slot<Item>): Item;
  useRealtimeConnectionState(): T.RealtimeConnectionState;
  useSettings(options?: { projectId?: string }): T.SettingsState;
  useExperiments(): Readonly<Record<string, boolean>>;
  usePluginId(): string;
  useBbContext(): T.BbContext;
  useBbNavigate(): T.BbNavigate;
  useCodeTheme(): T.CodeTheme | null;
  useProviders(): T.ProvidersState;
  useEnvironmentProviders(): T.EnvironmentProvidersState;
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
  callOp<O extends Op>(
    op: O,
    input: OpInput<O>,
    options?: RemoteCallOptions,
  ): Promise<OpOutput<O>>;
  describeApp(contractId?: string): KernelDescription;
  SlotMount: ComponentType<T.SlotMountProps>;
  Icon: ComponentType<T.IconProps>;
  ProviderIcon: ComponentType<T.ProviderIconProps>;
  UrlLink: ComponentType<T.UrlLinkProps>;
  ThreadViewers: ComponentType<T.ThreadViewersProps>;
  ImageLightbox: ComponentType<T.ImageLightboxProps>;
  Markdown: ComponentType<T.MarkdownProps>;
  Diff: ComponentType<T.DiffProps>;
  FileLink: ComponentType<T.FileLinkProps>;
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
export const useExperiments = hook("useExperiments");
export const usePluginId = hook("usePluginId");
export const useBbContext = hook("useBbContext");
export const useBbNavigate = hook("useBbNavigate");
export const useCodeTheme = hook("useCodeTheme");
export const useProviders = hook("useProviders");
export const useEnvironmentProviders = hook("useEnvironmentProviders");
export const useQuestionFormHost = hook("useQuestionFormHost");
export const useSlot = hook("useSlot");
export const useSlotEntries = hook("useSlotEntries");
export const useSlotEntry = hook("useSlotEntry");
export const useOp = hook("useOp");
export const useCall = hook("useCall");
export const useLive = hook("useLive");
export const useChanged = hook("useChanged");
export const callOp = hook("callOp");
export const describeApp = hook("describeApp");
export const SlotMount = component((h) => h.SlotMount);
export const Icon = component((h) => h.Icon);
export const ProviderIcon = component((h) => h.ProviderIcon);
export const UrlLink = component((h) => h.UrlLink);
export const ThreadViewers = component((h) => h.ThreadViewers);
export const ImageLightbox = component((h) => h.ImageLightbox);
export const Markdown = component((h) => h.Markdown);
export const Diff = component((h) => h.Diff);
export const FileLink = component((h) => h.FileLink);

function provided<Api extends object, Name extends keyof Api>(
  slot: Slot<Api>,
  name: Name,
): Api[Name] {
  const forward = (...args: unknown[]) =>
    (host().use(slot)[name] as (...args: unknown[]) => unknown)(...args);
  return forward as Api[Name];
}

export const useSidebarThreads = provided(shell.api, "useSidebarThreads");
export const useSidebarThreadActions = provided(
  shell.api,
  "useSidebarThreadActions",
);
export const useSidebarThreadSplit = provided(
  shell.api,
  "useSidebarThreadSplit",
);
export const useSidebarNavigationSplit = provided(
  shell.api,
  "useSidebarNavigationSplit",
);
export const useSidebarThreadDraft = provided(
  shell.api,
  "useSidebarThreadDraft",
);
export const useSidebarThreadDraftIds = provided(
  shell.api,
  "useSidebarThreadDraftIds",
);
export const useSidebarThreadRowStatus = provided(
  shell.api,
  "useSidebarThreadRowStatus",
);
export const useSidebarThreadRowStatuses = provided(
  shell.api,
  "useSidebarThreadRowStatuses",
);
export const useSidebarSplitLayout = provided(
  shell.api,
  "useSidebarSplitLayout",
);
export const useSidebarThreadShortcut = provided(
  shell.api,
  "useSidebarThreadShortcut",
);
export const useSidebarNavigation = provided(shell.api, "useSidebarNavigation");
export const useComposer = provided(composer.api, "useComposer");
export const useComposers = provided(composer.api, "useComposers");
export const SidebarNavigationIcon = component(
  (h) => h.use(shell.api).SidebarNavigationIcon,
);
export const ThreadChat = component((h) => h.use(threadView.api).ThreadChat);
export const ThreadTitle = component((h) => h.use(threadView.api).ThreadTitle);
