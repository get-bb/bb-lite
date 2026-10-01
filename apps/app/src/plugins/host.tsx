import { createElement, useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  BbContext,
  BbNavigate,
  PluginAppHost,
  PluginEnvironmentProvider,
  PluginEnvironmentProvidersState,
  PluginProvidersState,
  PluginRpcClient,
  PluginRpcContract,
  PluginSettingsState,
  PluginSidebarThreadRowStatus,
} from "@bb/plugin/app";
import { Icon } from "@bb/shared-ui/icon";
import { useQuestionFormHost } from "@bb/shared-ui/question-form-host";
import { PluginNewThreadComposer } from "@/components/plugin/PluginNewThreadComposer";
import { PluginPermissionModePicker } from "@/components/plugin/PluginPermissionModePicker";
import { PluginProviderModelPicker } from "@/components/plugin/PluginProviderModelPicker";
import { PluginThreadChat } from "@/components/plugin/PluginThreadChat";
import { PluginThreadTitle } from "@/components/plugin/PluginThreadTitle";
import { PluginUrlLink } from "@/components/plugin/PluginUrlLink";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { usePluginThreadPanelOpenHandler } from "@/components/plugin/plugin-thread-panel-navigation";
import { SidebarNavigationIcon } from "@/components/sidebar/SidebarNavigationModel";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { pluginSdkSettingsQueryKey } from "@/hooks/queries/query-keys";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { getPluginBoundSdk } from "@/lib/plugin-bound-sdk";
import {
  useSidebarThreadActions,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadShortcut,
  useSidebarThreads,
} from "@/lib/plugin-sidebar-hooks";
import {
  useSidebarNavigation,
  useSidebarNavigationSplit,
} from "@/lib/plugin-sidebar-navigation";
import {
  useSidebarSplitLayout,
  useSidebarThreadSplit,
} from "@/lib/plugin-sidebar-split";
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
    error?: unknown;
  } | null;
  if (response.ok && body?.ok === true) return body.result;
  const structured =
    typeof body?.error === "object" && body.error !== null ? body.error : null;
  const message =
    structured !== null &&
    typeof Reflect.get(structured, "message") === "string"
      ? String(Reflect.get(structured, "message"))
      : typeof body?.error === "string"
        ? body.error
        : `rpc "${method}" failed (HTTP ${response.status})`;
  const error = new Error(message);
  if (structured !== null) {
    const code = Reflect.get(structured, "code");
    const issues = Reflect.get(structured, "issues");
    if (typeof code === "string") Reflect.set(error, "code", code);
    if (Array.isArray(issues)) Reflect.set(error, "issues", issues);
  }
  throw error;
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

async function fetchPluginSettings(
  pluginId: string,
): Promise<Record<string, string | number | boolean> | null> {
  const response = await fetch(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/settings`,
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    values?: unknown;
  } | null;
  if (
    body?.ok !== true ||
    typeof body.values !== "object" ||
    body.values === null
  ) {
    return null;
  }
  const values: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(body.values)) {
    if (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    ) {
      values[key] = value;
    }
  }
  return values;
}

function useSettings(): PluginSettingsState {
  const pluginId = usePluginId();
  const query = useQuery({
    queryKey: pluginSdkSettingsQueryKey(pluginId),
    queryFn: () => fetchPluginSettings(pluginId),
    staleTime: 30_000,
  });
  return { values: query.data ?? undefined, isLoading: query.isLoading };
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
  return getPluginBoundSdk(sdk, pluginId, queryClient);
}

const EMPTY_ENVIRONMENT_PROVIDERS: readonly PluginEnvironmentProvider[] = [];

function useEnvironmentProviders(): PluginEnvironmentProvidersState {
  const { providers } = useSystemEnvironmentProviders();
  return useMemo<PluginEnvironmentProvidersState>(
    () =>
      providers === undefined
        ? { status: "loading", providers: EMPTY_ENVIRONMENT_PROVIDERS }
        : {
            status: "ready",
            providers: providers.map((provider) => ({
              id: provider.id,
              displayName: provider.displayName,
              description: provider.description,
              icon: provider.icon,
              logoUrl: provider.logoUrl,
              pluginId: provider.pluginId,
              machineProviderId: provider.machineProviderId,
            })),
          },
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
  const toThread = useCallback(
    (threadId: string) => {
      void sdk.threads
        .get({ threadId })
        .then((thread) =>
          navigate(
            getThreadRoutePath({ projectId: thread.projectId, threadId }),
          ),
        )
        .catch(() => navigate(`/threads/${threadId}`));
    },
    [navigate],
  );
  const toProject = useCallback(
    (projectId: string) => {
      void navigate(getProjectComposeRoutePath(projectId));
    },
    [navigate],
  );
  const toPluginPanel = useCallback(
    (path: string, options?: { subPath?: string; replace?: boolean }) => {
      const route = getPluginPanelRoutePath({
        pluginId,
        path,
        ...(options?.subPath !== undefined ? { subPath: options.subPath } : {}),
      });
      void navigate(route, options?.replace ? { replace: true } : undefined);
    },
    [navigate, pluginId],
  );
  const toCompose = useCallback(
    (options?: { initialPrompt?: string; focusPrompt?: boolean }) => {
      void navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: options?.focusPrompt ?? false,
          initialPrompt: options?.initialPrompt ?? "",
        },
      });
    },
    [navigate],
  );
  const openThreadPanel = useCallback<BbNavigate["openThreadPanel"]>(
    (options) => openThreadPanelHandler?.({ ...options, pluginId }) ?? false,
    [openThreadPanelHandler, pluginId],
  );
  const openUrl = useCallback<BbNavigate["openUrl"]>(
    (url) => appNavigation.openUrl({ url }),
    [appNavigation],
  );
  return useMemo(
    () => ({
      toThread,
      toProject,
      toPluginPanel,
      toCompose,
      openThreadPanel,
      openUrl,
    }),
    [toThread, toProject, toPluginPanel, toCompose, openThreadPanel, openUrl],
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
  NewThreadComposer: PluginNewThreadComposer,
  ProviderModelPicker: PluginProviderModelPicker,
  PermissionModePicker: PluginPermissionModePicker,
  Icon,
  ProviderIcon,
  UrlLink: PluginUrlLink,
  ThreadTitle: PluginThreadTitle,
};
