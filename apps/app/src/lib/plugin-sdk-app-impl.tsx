import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { Icon } from "@bb/shared-ui/icon";
import type { PluginSdkApp } from "@get-bb/plugin-sdk";
import { PluginNewThreadComposer } from "@/components/plugin/PluginNewThreadComposer";
import { PluginProviderModelPicker } from "@/components/plugin/PluginProviderModelPicker";
import { PluginPermissionModePicker } from "@/components/plugin/PluginPermissionModePicker";
import { PluginThreadChat } from "@/components/plugin/PluginThreadChat";
import { PluginThreadTitle } from "@/components/plugin/PluginThreadTitle";
import { PluginUrlLink } from "@/components/plugin/PluginUrlLink";
import { usePluginId } from "@/components/plugin/plugin-context";
import { useQuestionFormHost } from "@bb/shared-ui/question-form-host";
import { definePluginApp } from "./plugin-app-definition";
import {
  useBbContext,
  useBbNavigate,
  useEnvironmentProviders,
  useProviders,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  useSettings,
} from "./plugin-sdk-hooks";
import {
  useSidebarThreadActions,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut,
  useSidebarThreads,
} from "./plugin-sidebar-hooks";
import {
  useSidebarSplitLayout,
  useSidebarThreadSplit,
} from "./plugin-sidebar-split";
import {
  useSidebarNavigation,
  useSidebarNavigationSplit,
} from "./plugin-sidebar-navigation";
import { SidebarNavigationIcon } from "@/components/sidebar/SidebarNavigationModel";

export const pluginSdkAppImplementation = {
  definePluginApp,
  experimental_Icon: Icon,
  experimental_ProviderIcon: ProviderIcon,
  useBbContext,
  experimental_usePluginId: usePluginId,
  experimental_useQuestionFormHost: useQuestionFormHost,
  useBbNavigate: useBbNavigate as PluginSdkApp["useBbNavigate"],
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  ThreadChat: PluginThreadChat,
  UrlLink: PluginUrlLink,
  experimental_NewThreadComposer: PluginNewThreadComposer,
  experimental_ProviderModelPicker: PluginProviderModelPicker,
  experimental_PermissionModePicker: PluginPermissionModePicker,
  experimental_useSidebarThreads: useSidebarThreads,
  experimental_useSidebarThreadActions: useSidebarThreadActions,
  experimental_useSidebarThreadSplit: useSidebarThreadSplit,
  experimental_useSidebarNavigation: useSidebarNavigation,
  experimental_useSidebarNavigationSplit: useSidebarNavigationSplit,
  experimental_SidebarNavigationIcon: SidebarNavigationIcon,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarSplitLayout,
  useSidebarThreadShortcut,
  ThreadTitle: PluginThreadTitle,
  useEnvironmentProviders,
  useSdk,
  experimental_useProviders: useProviders,
} satisfies Partial<PluginSdkApp>;
