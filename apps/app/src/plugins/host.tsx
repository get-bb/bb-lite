import { createElement, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  BbContext,
  BbNavigate,
  PluginAppHost,
  PluginEnvironmentProvidersState,
  PluginProvidersState,
  PluginRpcClient,
  PluginRpcContract,
  PluginSettingsState,
  PluginSidebarThreadRowStatus,
} from "@bb/plugin/app";
import { Icon } from "@bb/shared-ui/icon";
import { useQuestionFormHost } from "@bb/shared-ui/question-form-host";
import { PluginThreadChat } from "@/components/plugin/PluginThreadChat";
import { PluginThreadTitle } from "@/components/plugin/PluginThreadTitle";
import { PluginUrlLink } from "@/components/plugin/PluginUrlLink";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { usePluginThreadPanelOpenHandler } from "@/components/plugin/plugin-thread-panel-navigation";
import { SidebarNavigationIcon } from "@/components/sidebar/SidebarNavigationModel";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { usePluginSettingsView } from "@/hooks/queries/plugin-settings-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { getPluginBoundSdk } from "@/lib/plugin-bound-sdk";
import {
  useSidebarNavigation,
  useSidebarNavigationSplit,
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

async function callPluginRpc(
  pluginId: string,
  method: string,
  input: unknown,
): Promise<unknown> {
  const response = await fetch(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? null),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    result?: unknown;
    error?: string | { message?: unknown; code?: unknown; issues?: unknown };
  } | null;
  if (response.ok && body?.ok === true) return body.result;
  const failure = body?.error;
  const { message, code, issues } =
    typeof failure === "object" ? failure : { message: failure };
  const fallback = `rpc "${method}" failed (HTTP ${response.status})`;
  throw Object.assign(
    new Error(typeof message === "string" ? message : fallback),
    typeof code === "string" ? { code } : {},
    Array.isArray(issues) ? { issues } : {},
  );
}

function useRpc<
  Contract extends PluginRpcContract = PluginRpcContract,
>(): PluginRpcClient<Contract> {
  const pluginId = usePluginId();
  const client = useMemo(
    () => ({
      call: (method: string, input?: unknown) =>
        callPluginRpc(pluginId, method, input),
    }),
    [pluginId],
  );
  return client as PluginRpcClient<Contract>;
}

function useRealtime(
  channel: string,
  handler: (payload: unknown) => void,
): void {
  const pluginId = usePluginId();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(
    () =>
      wsManager.onPluginSignal((signal) => {
        if (signal.pluginId !== pluginId || signal.channel !== channel) return;
        handlerRef.current(signal.payload);
      }),
    [pluginId, channel],
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
  useRpc,
  useRealtime,
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
  useSidebarNavigationSplit,
  useQuestionFormHost,
  SidebarNavigationIcon,
  ThreadChat: PluginThreadChat,
  Icon,
  ProviderIcon,
  UrlLink: PluginUrlLink,
  ThreadTitle: PluginThreadTitle,
};
