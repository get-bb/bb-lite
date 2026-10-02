import type {
  ComponentPropsWithoutRef,
  ComponentType,
  CSSProperties,
  PointerEvent,
  ReactNode,
} from "react";
import type {
  EnvironmentWorkspaceDisplayKind,
  JsonValue,
  PermissionMode,
  PromptInput,
  ProviderInfo,
  ReasoningLevel,
  ServiceTier,
  ThreadQueuedWork,
  ThreadRuntimeDisplayStatus,
  ThreadStatus,
} from "@bb/domain";
import type {
  CreateExecutionInputSources,
  CreateThreadEnvironmentArgs,
} from "@bb/server-contract";

export interface PluginNavPanelProps {
  subPath: string;
}

export interface PluginThreadPanelProps {
  threadId: string;
  params: JsonValue | null;
}

export interface PluginPendingInteractionView {
  id: string;
  threadId: string;
  title: string;
  payload: JsonValue;
  createdAt: number;
  expiresAt: number | null;
}

export interface PluginPendingInteractionProps {
  interaction: PluginPendingInteractionView;
  submit(value: JsonValue): Promise<void>;
  cancel(): Promise<void>;
}

export interface ShortcutHint {
  label: string;
  ariaKeyshortcuts: string;
}

export interface QuestionFormHost {
  shortcuts: ReadonlyMap<string, ShortcutHint>;
  registerChoiceHandler(handler: (index: number) => boolean): () => void;
}

export interface PluginMessageDirectiveMessage {
  id: string;
  threadId: string;
  turnId: string | null;
  projectId: string | null;
}

export interface PluginMessageDirectiveProps {
  attributes: Readonly<Record<string, string>>;
  source: string;
  message: PluginMessageDirectiveMessage;
  openWorkspaceFile: ((path: string) => boolean) | null;
}

export type SidebarNavigationAction =
  | { kind: "new-thread" }
  | { kind: "search-threads" }
  | { kind: "open-plugin-panel"; pluginId: string; panelId: string };

export type SidebarNavigationItemIcon =
  | { kind: "host"; name: "new-thread" | "search" }
  | { kind: "plugin"; pluginId: string; icon: string | null };

export interface SidebarNavigationItem {
  id: string;
  label: string;
  icon: SidebarNavigationItemIcon;
  action: SidebarNavigationAction;
  isDisabled: boolean;
  isVisible: boolean;
  isLoading: boolean;
  pluginId: string | null;
  shortcut: { label: string; ariaKeyShortcuts: string } | null;
  Accessory: ComponentType | null;
}

export interface SidebarNavigationActions {
  activate(itemId: string, options: { openInSplit: boolean }): void;
  setVisible(itemId: string, isVisible: boolean): void;
  setOrder(itemIds: readonly string[]): void;
  openCustomize(): void;
  disablePlugin(itemId: string): Promise<void>;
}

export interface SidebarNavigationState {
  items: readonly SidebarNavigationItem[];
  activeItemId: string | null;
  isShortcutModifierHeld: boolean;
  actions: SidebarNavigationActions;
}

export interface PluginSidebarSplitPane {
  paneId: string;
  rect: { x: number; y: number; width: number; height: number };
  isMe: boolean;
  isFocused: boolean;
}

export interface PluginSidebarThreadSplit {
  splitProps: { onPointerDown?: (event: PointerEvent<HTMLElement>) => void };
  isAvailable: boolean;
  layout: { panes: readonly PluginSidebarSplitPane[] } | null;
}

export interface SidebarNavigationSplitOptions {
  activation?: "sidebar" | "distance";
  onDragStart?: () => void;
}

export interface SidebarNavigationIconProps {
  icon: SidebarNavigationItemIcon;
  className?: string;
}

export interface SidebarHeaderProps {
  width: number;
  controlSize: number;
}

export interface PluginThreadListProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  searchQuery: string;
}

export interface PluginSettingsSectionRegistration {
  id: string;
  title?: string;
  description?: string;
  component: ComponentType;
}

export interface PluginComponentRegistration<Props = object> {
  id: string;
  component: ComponentType<Props>;
}

export interface PluginProviderRegistration<Props = object> {
  id: string;
  title: string;
  description?: string;
  component: ComponentType<Props>;
}

export interface PluginFixedTabRegistration {
  panelId: string;
  id: string;
  title: string;
  icon: string;
  component: ComponentType<PluginNavPanelProps>;
  layout?: "padded" | "flush";
}

export interface PluginNavPanelRegistration {
  id: string;
  title: string;
  icon: string;
  path: string;
  component: ComponentType<PluginNavPanelProps>;
  fixedTabs?: readonly PluginFixedTabRegistration[];
  headerContent?: ComponentType<PluginNavPanelProps>;
  sidebarAccessory?: ComponentType;
}

export interface PluginPanelOpenOptions {
  title?: string;
  params?: JsonValue;
}

export interface PluginTargetedPanelOpenOptions extends PluginPanelOpenOptions {
  actionId: string;
}

export interface PluginThreadPanelContext {
  threadId: string;
  openPanel(options?: PluginPanelOpenOptions): boolean;
}

export interface PluginThreadPanelRegistration {
  id: string;
  title: string;
  icon?: string;
  component: ComponentType<PluginThreadPanelProps>;
  layout?: "padded" | "flush";
  run?(context: PluginThreadPanelContext): void | Promise<void>;
}

export interface PluginCommandContext {
  threadId: string | null;
  projectId: string | null;
  openPanel(options: PluginTargetedPanelOpenOptions): boolean;
}

export interface PluginCommandShortcut {
  key: string;
  mod?: boolean;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface PluginCommandRegistration {
  id: string;
  title: string;
  defaultShortcut?: PluginCommandShortcut;
  isAvailable?(context: PluginCommandContext): boolean;
  run(context: PluginCommandContext): void | Promise<void>;
}

export type PluginSidebarThreadIndicator =
  | "unread-error"
  | "waiting-for-input"
  | "working-draft"
  | "workflow"
  | "background-agent"
  | "background-command"
  | "plan-mode"
  | "goal"
  | "runtime"
  | "queued-failed"
  | "draft"
  | "unread-success"
  | "queued-waiting"
  | "none";

export interface PluginSidebarThreadActivity {
  workflows: number;
  backgroundAgents: number;
  backgroundCommands: number;
  planMode: number;
  goals: number;
}

export interface PluginSidebarThread {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  displayTitle: string;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  sourceThreadId: string | null;
  sectionId: string | null;
  originKind: "fork" | null;
  originPluginId: string | null;
  providerId: string;
  status: ThreadStatus;
  runtimeStatus: ThreadRuntimeDisplayStatus;
  queuedWork: ThreadQueuedWork;
  hasPendingInteraction: boolean;
  activity: PluginSidebarThreadActivity;
  indicator: PluginSidebarThreadIndicator;
  indicatorLabel: string | null;
  isUnread: boolean;
  isPinned: boolean;
  pinnedAt: number | null;
  pinSortKey: string | null;
  isArchived: boolean;
  archivedAt: number | null;
  href: string;
  isHidden: boolean;
  environment: {
    id: string | null;
    name: string | null;
    branchName: string | null;
    path: string | null;
    isWorktree: boolean | null;
    providerId: string | null;
    workspaceDisplayKind: EnvironmentWorkspaceDisplayKind | null;
  } | null;
  host: { id: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

export interface PluginSidebarProject {
  id: string;
  name: string;
  isPersonal: boolean;
  href: string;
  settingsHref: string;
}

export interface PluginSidebarSection {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface PluginSidebarThreadsState {
  archived: {
    status: "loading" | "ready" | "error";
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isFetchNextPageError: boolean;
    fetchNextPage(): Promise<void>;
  } | null;
  status: "loading" | "ready" | "error";
  threads: readonly PluginSidebarThread[];
  hosts?: readonly { id: string; name: string }[];
  projects: readonly PluginSidebarProject[];
  sections: readonly PluginSidebarSection[];
}

export interface PluginSidebarThreadActions {
  open(threadId: string, options?: { split?: boolean }): void;
  openNewThread(options?: {
    projectId?: string;
    sectionId?: string;
    placement?: { sectionId: string | null; pinned: boolean };
    environmentId?: string;
    hostId?: string;
    focusPrompt?: boolean;
  }): void;
  setPinned(threadId: string, pinned: boolean): Promise<void>;
  setRead(threadId: string, read: boolean): Promise<void>;
  rename(threadId: string, title: string): Promise<void>;
  archive(threadId: string): void;
  requestDelete(threadId: string): void;
}

export interface PluginSidebarThreadDraftState {
  hasUnsubmittedDraft: boolean;
}

export interface PluginSidebarThreadRowStatus {
  icon: string;
  label: string;
  tone?: "default" | "running" | "success" | "error";
}

export interface PluginSidebarSplitLayout {
  panes: readonly {
    paneId: string;
    rect: { x: number; y: number; width: number; height: number };
    threadId: string | null;
    isFocused: boolean;
  }[];
}

export interface PluginProvidersState {
  status: "loading" | "ready" | "error";
  providers: readonly ProviderInfo[];
}

export interface PluginEnvironmentProvider {
  id: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  logoUrl: string | null;
  pluginId: string;
  machineProviderId: string | null;
}

export interface PluginEnvironmentProvidersState {
  status: "loading" | "ready" | "error";
  providers: readonly PluginEnvironmentProvider[];
}

interface SchemaLike {
  readonly "~standard": {
    readonly types?: { readonly input: unknown; readonly output: unknown };
  };
}

type SchemaInput<Schema extends SchemaLike> = NonNullable<
  Schema["~standard"]["types"]
>["input"];

type SchemaOutput<Schema extends SchemaLike> = NonNullable<
  Schema["~standard"]["types"]
>["output"];

export type PluginRpcContract = Readonly<
  Record<string, { readonly input: SchemaLike; readonly output: SchemaLike }>
>;

export interface PluginRpcClient<
  Contract extends PluginRpcContract = PluginRpcContract,
> {
  call<Method extends Extract<keyof Contract, string>>(
    method: Method,
    ...args: null extends SchemaInput<Contract[Method]["input"]>
      ? [input?: SchemaInput<Contract[Method]["input"]>]
      : [input: SchemaInput<Contract[Method]["input"]>]
  ): Promise<SchemaOutput<Contract[Method]["output"]>>;
}

export interface PluginSettingsState {
  values: Record<string, string | boolean> | undefined;
  isLoading: boolean;
}

export type PluginRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

export interface BbContext {
  projectId: string | null;
  threadId: string | null;
}

export interface BbNavigate {
  toThread(threadId: string): void;
  toProject(projectId: string): void;
  toPluginPanel(
    path: string,
    options?: { subPath?: string; replace?: boolean },
  ): void;
  toCompose(options?: { initialPrompt?: string; focusPrompt?: boolean }): void;
  openThreadPanel(options: PluginTargetedPanelOpenOptions): boolean;
  openUrl(url: string): boolean;
}

export interface IconProps {
  name: string;
  fallback?: string;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export interface ProviderIconProps {
  providerKind: "agent" | "machine" | "environment";
  provider: {
    id: string;
    logoUrl?: string | null;
    icon?: { glyph: string } | string | null;
    strings?: { iconTint?: { light: string; dark: string } | null } | null;
  };
  fallback?: string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export interface UrlLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "href"
> {
  href: string;
}

export interface ThreadChatProps {
  threadId: string;
  variant?: "full" | "compact" | "timeline";
  layout?: "contained" | "document";
  focusRequest?: number;
  className?: string;
  leadingContent?: ReactNode;
}

export interface NewThreadRequest {
  projectId: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  serviceTier?: ServiceTier;
  executionInputSources: CreateExecutionInputSources;
  environment: CreateThreadEnvironmentArgs;
  input: PromptInput[];
}
