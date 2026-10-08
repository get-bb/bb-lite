import { createElement, useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  BbContext,
  BbNavigate,
  Live,
  Op,
  OpState,
  PluginAppHost,
  PluginEnvironmentProvidersState,
  PluginProvidersState,
  PluginSettingsState,
  PluginSidebarThreadRowStatus,
} from "@bb/plugin/app";
import { Icon } from "@bb/shared-ui/icon";
import { useQuestionFormHost } from "@bb/shared-ui/question-form-host";
import { PluginThreadChat } from "@/components/plugin/PluginThreadChat";
import { PluginThreadTitle } from "@/components/plugin/PluginThreadTitle";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { ThreadViewers } from "@/components/users/ThreadViewers";
import { PluginUrlLink } from "@/components/plugin/PluginUrlLink";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { usePluginThreadPanelOpenHandler } from "@/components/plugin/plugin-thread-panel-navigation";
import { SidebarNavigationIcon } from "@/components/sidebar/SidebarNavigationModel";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { usePluginSettingsView } from "@/hooks/queries/plugin-settings-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import { useAppNavigationHost } from "@/lib/url-open-routing";
import { getPluginBoundSdk } from "@/lib/plugin-bound-sdk";
import {
  useSidebarNavigation,
  useSidebarSplitLayout,
  useSidebarThreadActions,
  useSidebarThreadSplit,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadShortcut,
  useSidebarThreads,
} from "@/lib/plugin-sidebar-hooks";
import {
  getPluginPanelRoutePath,
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { usePluginId } from "./context";
import { callRemoteOp } from "./ops";
import { callOp } from "./registry";
import { SlotMount, useSlot, useSlotEntries, useSlotEntry } from "./slots";

export const OP_QUERY_KEY = "op";

function useOp<O extends Op>(
  op: O,
  input: unknown,
  options: { enabled?: boolean } = {},
): OpState<never> {
  const query = useQuery({
    queryKey: [OP_QUERY_KEY, op.name, input],
    queryFn: () => callOp(op, input),
    enabled: options.enabled ?? true,
  });
  const { data, error, status, refetch } = query;
  return useMemo(
    () => ({
      status:
        status === "pending"
          ? "loading"
          : status === "error"
            ? "error"
            : "ready",
      data: data as never,
      error,
      refetch: () => void refetch(),
    }),
    [data, error, status, refetch],
  );
}

function useCall<O extends Op>(op: O) {
  return useCallback(
    (input: unknown) => callOp(op, input) as Promise<never>,
    [op],
  );
}

function useLive<L extends Live>(live: L) {
  const query = useQuery({
    queryKey: [OP_QUERY_KEY, live.name],
    queryFn: () => callRemoteOp(live.name, {}),
  });
  return query.data as never;
}

function useChanged(member: Op | Live, handler: () => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  const { name } = member;
  useEffect(
    () =>
      wsManager.onPluginSignal(({ pluginId, channel, payload }) => {
        if (pluginId !== "kernel" || channel !== "changed") return;
        if ((payload as { name?: unknown }).name === name) handlerRef.current();
      }),
    [name],
  );
}

function useSettings(): PluginSettingsState {
  const query = usePluginSettingsView(usePluginId(), { enabled: true });
  const stored = query.data?.values;
  const values = useMemo(() => {
    if (stored === undefined) return undefined;
    const plain: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === "string" || typeof value === "boolean")
        plain[key] = value;
    }
    return plain;
  }, [stored]);
  return { values, isLoading: query.isLoading };
}

const EMPTY_PROVIDERS: readonly never[] = [];

function useProviders(): PluginProvidersState {
  const query = useSystemProviders();
  const providers = query.data;
  return useMemo<PluginProvidersState>(
    () =>
      providers === undefined
        ? {
            status: query.isError ? "error" : "loading",
            providers: EMPTY_PROVIDERS,
          }
        : { status: "ready", providers },
    [providers, query.isError],
  );
}

function useSdk() {
  const pluginId = usePluginId();
  const queryClient = useQueryClient();
  return getPluginBoundSdk(pluginId, queryClient);
}

function useEnvironmentProviders(): PluginEnvironmentProvidersState {
  const { providers } = useSystemEnvironmentProviders();
  return useMemo<PluginEnvironmentProvidersState>(
    () =>
      providers === undefined
        ? { status: "loading", providers: EMPTY_PROVIDERS }
        : { status: "ready", providers },
    [providers],
  );
}

function useBbContext(): BbContext {
  const { projectId, threadId } = useRouteState();
  return useMemo(
    () => ({ projectId: projectId ?? null, threadId: threadId ?? null }),
    [projectId, threadId],
  );
}

function useBbNavigate(): BbNavigate {
  const pluginId = usePluginId();
  const openThreadPanelHandler = usePluginThreadPanelOpenHandler();
  const navigate = useNavigate();
  const appNavigation = useAppNavigationHost();
  return useMemo<BbNavigate>(
    () => ({
      toThread(threadId) {
        void sdk.threads
          .get({ threadId })
          .then((thread) =>
            navigate(
              getThreadRoutePath({ projectId: thread.projectId, threadId }),
            ),
          )
          .catch(() => navigate(`/threads/${threadId}`));
      },
      toProject: (projectId) =>
        void navigate(getProjectComposeRoutePath(projectId)),
      toPluginPanel(path, options) {
        const { subPath, replace } = options ?? {};
        const route = getPluginPanelRoutePath({
          pluginId,
          path,
          ...(subPath === undefined ? {} : { subPath }),
        });
        void navigate(route, replace ? { replace: true } : undefined);
      },
      toCompose: (options) =>
        void navigate(getRootComposeRoutePath(), {
          state: {
            focusPrompt: options?.focusPrompt ?? false,
            initialPrompt: options?.initialPrompt ?? "",
          },
        }),
      openThreadPanel: (options) =>
        openThreadPanelHandler?.({ ...options, pluginId }) ?? false,
      openUrl: (url) => appNavigation.openUrl({ url }),
    }),
    [appNavigation, navigate, openThreadPanelHandler, pluginId],
  );
}

const NO_ROW_STATUSES: ReadonlyMap<string, PluginSidebarThreadRowStatus> =
  new Map();

export const pluginAppHost: PluginAppHost = {
  createElement,
  useRealtimeConnectionState: useServerConnectionState,
  useSettings,
  useSdk,
  usePluginId,
  useBbContext,
  useBbNavigate,
  useSidebarThreads,
  useSidebarThreadActions,
  useSidebarThreadSplit,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus: () => null,
  useSidebarThreadRowStatuses: () => NO_ROW_STATUSES,
  useSidebarSplitLayout,
  useSidebarThreadShortcut,
  useProviders,
  useEnvironmentProviders,
  useSidebarNavigation,
  useQuestionFormHost,
  useSlot,
  useSlotEntries,
  useSlotEntry,
  useOp,
  useCall,
  useLive,
  useChanged,
  callOp: (op, input) => callOp(op, input) as Promise<never>,
  SlotMount,
  SidebarNavigationIcon,
  ThreadChat: PluginThreadChat,
  Icon,
  ProviderIcon,
  UrlLink: PluginUrlLink,
  ThreadTitle: PluginThreadTitle,
  ThreadViewers,
  ImageLightbox,
  Markdown: MarkdownPreview,
};
