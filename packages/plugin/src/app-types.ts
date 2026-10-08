import type {
  ComponentPropsWithoutRef,
  ComponentType,
  CSSProperties,
  ReactNode,
} from "react";
import type {
  EnvironmentWorkspaceDisplayKind,
  JsonValue,
  ProviderInfo,
  ThreadQueuedWork,
  ThreadRuntimeDisplayStatus,
  ThreadStatus,
} from "@bb/domain";

export interface SlotMountProps {
  pluginId: string;
  slot: string;
  id: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export interface ImageLightboxProps {
  hasMultipleImages?: boolean;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  navigationStatus?: string;
  imageAlt: string;
  imageSrc: string | null;
  isOpen?: boolean;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  title: string;
}

export interface MarkdownProps {
  content: string;
  className?: string;
  allowHtml?: boolean;
  sourcePrefix?: string;
}

export interface ShellNavPanelProps {
  subPath: string;
}

export interface SidePanelPanelProps {
  threadId: string;
  params: JsonValue | null;
}

export interface InteractionView {
  id: string;
  threadId: string;
  title: string;
  payload: JsonValue;
  createdAt: number;
  expiresAt: number | null;
}

export interface InteractionProps {
  interaction: InteractionView;
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

export interface MessageDirectiveMessage {
  id: string;
  threadId: string;
  turnId: string | null;
  projectId: string | null;
}

export interface MessageDirectiveProps {
  attributes: Readonly<Record<string, string>>;
  source: string;
  message: MessageDirectiveMessage;
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
}

export interface SidebarNavigationActions {
  activate(itemId: string, options: { openInSplit: boolean }): void;
  disablePlugin(itemId: string): Promise<void>;
}

export interface SidebarNavigationState {
  items: readonly SidebarNavigationItem[];
  activeItemId: string | null;
  isShortcutModifierHeld: boolean;
  actions: SidebarNavigationActions;
}

export interface SidebarSplitPane {
  paneId: string;
  rect: { x: number; y: number; width: number; height: number };
  isMe: boolean;
  isFocused: boolean;
}

export interface SidebarSplit {
  isAvailable: boolean;
  layout: { panes: readonly SidebarSplitPane[] } | null;
}

export interface ThreadViewersProps {
  threadId: string;
  className?: string;
}

export interface SidebarNavigationIconProps {
  icon: SidebarNavigationItemIcon;
  className?: string;
}

export interface SidebarNavigationProps {
  isCompactViewport: boolean;
}

export interface SidebarHeaderProps {
  width: number;
  controlSize: number;
  isCompactViewport: boolean;
}

export interface ShellThreadListProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
  searchQuery: string;
}

export interface SettingsPageSection {
  id: string;
  title?: string;
  description?: string;
  view: ComponentType;
}

export interface ShellOverlay {
  id: string;
  view: ComponentType;
}

export interface InteractionRenderer {
  id: string;
  view: ComponentType<InteractionProps>;
}

export interface MessageDirective {
  id: string;
  view: ComponentType<MessageDirectiveProps>;
}

export interface ShellProvider<Props = object> {
  id: string;
  title: string;
  description?: string;
  view: ComponentType<Props>;
}

export interface ShellNavPanelTab {
  panelId: string;
  id: string;
  title: string;
  icon: string;
  view: ComponentType<ShellNavPanelProps>;
  layout?: "padded" | "flush";
}

export interface ShellNavPanel {
  id: string;
  title: string;
  icon: string;
  path: string;
  view: ComponentType<ShellNavPanelProps>;
  fixedTabs?: readonly ShellNavPanelTab[];
  headerView?: ComponentType<ShellNavPanelProps>;
}

export interface PanelOpenOptions {
  title?: string;
  params?: JsonValue;
}

export interface TargetedPanelOpenOptions extends PanelOpenOptions {
  actionId: string;
}

export interface SidePanelPanelContext {
  threadId: string;
  openPanel(options?: PanelOpenOptions): boolean;
}

export interface SidePanelPanel {
  id: string;
  title: string;
  icon?: string;
  view: ComponentType<SidePanelPanelProps>;
  layout?: "padded" | "flush";
  run?(context: SidePanelPanelContext): void | Promise<void>;
}

export interface CommandContext {
  threadId: string | null;
  projectId: string | null;
  openPanel(options: TargetedPanelOpenOptions): boolean;
}

export interface CommandShortcut {
  key: string;
  mod?: boolean;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface ShellCommand {
  id: string;
  title: string;
  defaultShortcut?: CommandShortcut;
  isAvailable?(context: CommandContext): boolean;
  run(context: CommandContext): void | Promise<void>;
}

export type SidebarThreadIndicator =
  | "unread-error"
  | "waiting-for-input"
  | "working-draft"
  | "workflow"
  | "background-agent"
  | "background-command"
  | "goal"
  | "runtime"
  | "queued-failed"
  | "draft"
  | "unread-success"
  | "queued-waiting"
  | "none";

export interface SidebarThreadActivity {
  workflows: number;
  backgroundAgents: number;
  backgroundCommands: number;
  goals: number;
}

export interface SidebarThread {
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
  activity: SidebarThreadActivity;
  indicator: SidebarThreadIndicator;
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

export interface SidebarProject {
  id: string;
  name: string;
  isPersonal: boolean;
  href: string;
  settingsHref: string;
}

export interface SidebarSection {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface SidebarThreadsState {
  archived: {
    status: "loading" | "ready" | "error";
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isFetchNextPageError: boolean;
    fetchNextPage(): Promise<void>;
  } | null;
  status: "loading" | "ready" | "error";
  threads: readonly SidebarThread[];
  hosts?: readonly { id: string; name: string }[];
  projects: readonly SidebarProject[];
  sections: readonly SidebarSection[];
}

export interface SidebarThreadActions {
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

export interface SidebarThreadDraftState {
  hasUnsubmittedDraft: boolean;
}

export interface ThreadRowStatus {
  icon: string;
  label: string;
  tone?: "default" | "running" | "success" | "error";
}

export interface ThreadRowStatusEntry extends ThreadRowStatus {
  threadId: string;
}

export interface AppIcon {
  name: string;
  view: ComponentType<{ className?: string }>;
}

export interface SidebarSplitLayout {
  panes: readonly {
    paneId: string;
    rect: { x: number; y: number; width: number; height: number };
    threadId: string | null;
    isFocused: boolean;
  }[];
}

export interface ProvidersState {
  status: "loading" | "ready" | "error";
  providers: readonly ProviderInfo[];
}

export interface EnvironmentProviderInfo {
  id: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  logoUrl: string | null;
  pluginId: string;
  machineProviderId: string | null;
}

export interface EnvironmentProvidersState {
  status: "loading" | "ready" | "error";
  providers: readonly EnvironmentProviderInfo[];
}

export interface SettingsState {
  values: Record<string, string | boolean | number> | undefined;
  isLoading: boolean;
}

export type RealtimeConnectionState =
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
  openThreadPanel(options: TargetedPanelOpenOptions): boolean;
  openUrl(url: string): boolean;
  openFile(options: { threadId: string; path: string }): boolean;
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
