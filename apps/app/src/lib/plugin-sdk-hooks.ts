import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import type {
  BbContext,
  BbNavigate,
  PluginRealtimeConnectionState,
  PluginRpcContract,
  PluginRpcClient,
  PluginBrowserBbSdk,
  PluginEnvironmentProvider,
  PluginEnvironmentProvidersState,
  PluginProvidersState,
  PluginSettingsState,
} from "@get-bb/plugin-sdk";
import { usePluginId } from "@/components/plugin/plugin-context";
import { usePluginThreadPanelOpenHandler } from "@/components/plugin/plugin-thread-panel-navigation";
import { sdk } from "@/lib/sdk";
import { getPluginBoundSdk } from "@/lib/plugin-bound-sdk";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import {
  AUTOMATIONS_PLUGIN_ID,
  getPluginPanelRoutePath,
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
  AUTOMATION_EDIT_ROUTE_PATH,
} from "@/lib/route-paths";
import { useRouteState } from "@/hooks/useRouteState";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import { wsManager } from "@/lib/ws";
import { pluginSdkSettingsQueryKey } from "@/hooks/queries/query-keys";
import { useAppNavigationHost } from "@/lib/app-navigation-host";

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export function isAutomationEditRoutePath(pathname: string): boolean {
  return (
    matchPath({ path: AUTOMATION_EDIT_ROUTE_PATH, end: true }, pathname) !==
    null
  );
}

function serializePluginRpcInput(value: unknown): string {
  const ancestors = new Set<object>();
  function assertJson(current: unknown, path: string): void {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`rpc input at ${path} contains a non-finite number`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`rpc input at ${path} is not a JSON value`);
    }
    if (ancestors.has(current)) {
      throw new Error(`rpc input at ${path} is cyclic`);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        current.forEach((item, index) => assertJson(item, `${path}[${index}]`));
        return;
      }
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`rpc input at ${path} must be a plain JSON object`);
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === "symbol") {
          throw new Error(`rpc input at ${path} contains a symbol key`);
        }
      }
      for (const [key, child] of Object.entries(current)) {
        assertJson(child, `${path}.${key}`);
      }
    } finally {
      ancestors.delete(current);
    }
  }
  assertJson(value, "$input");
  return JSON.stringify(value);
}

export async function callPluginRpc(
  fetchImpl: FetchLike,
  pluginId: string,
  method: string,
  input?: unknown,
): Promise<unknown> {
  const serializedInput = serializePluginRpcInput(input ?? null);
  const response = await fetchImpl(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serializedInput,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    result?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || body?.ok !== true) {
    const structured =
      typeof body?.error === "object" && body.error !== null
        ? body.error
        : null;
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
  return body.result;
}

export async function fetchPluginSdkSettings(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<Record<string, string | number | boolean> | null> {
  const response = await fetchImpl(
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

export function useRpc<
  Contract extends PluginRpcContract = PluginRpcContract,
>(): PluginRpcClient<Contract> {
  const pluginId = usePluginId();
  const client = useMemo(
    () => ({
      call: (method: string, input?: unknown) =>
        callPluginRpc(fetch, pluginId, method, input),
    }),
    [pluginId],
  );
  return client as PluginRpcClient<Contract>;
}

export function useRealtime(
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

export function useRealtimeConnectionState(): PluginRealtimeConnectionState {
  return useServerConnectionState();
}

export function useSettings(): PluginSettingsState {
  const pluginId = usePluginId();
  const query = useQuery({
    queryKey: pluginSdkSettingsQueryKey(pluginId),
    queryFn: () => fetchPluginSdkSettings(fetch, pluginId),
    staleTime: 30_000,
  });
  return {
    values: query.data ?? undefined,
    isLoading: query.isLoading,
  };
}

const EMPTY_PROVIDERS: readonly never[] = [];

export function useProviders(): PluginProvidersState {
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

export function useSdk(): PluginBrowserBbSdk {
  const pluginId = usePluginId();
  const queryClient = useQueryClient();
  return getPluginBoundSdk(sdk, pluginId, queryClient);
}

const EMPTY_ENVIRONMENT_PROVIDERS: readonly PluginEnvironmentProvider[] = [];

export function useEnvironmentProviders(): PluginEnvironmentProvidersState {
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

export function useBbContext(): BbContext {
  const { projectId, threadId } = useRouteState();
  return useMemo(
    () => ({ projectId: projectId ?? null, threadId: threadId ?? null }),
    [projectId, threadId],
  );
}

export function useBbNavigate(): Omit<
  BbNavigate,
  "experimental_openFilePreview" | "experimental_openFileExternally"
> {
  const pluginId = usePluginId();
  const location = useLocation();
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
      const replacesAutomationEditRoute =
        pluginId === AUTOMATIONS_PLUGIN_ID &&
        isAutomationEditRoutePath(location.pathname);
      void navigate(getRootComposeRoutePath(), {
        ...(replacesAutomationEditRoute ? { replace: true } : {}),
        state: {
          focusPrompt: options?.focusPrompt ?? false,
          initialPrompt: options?.initialPrompt ?? "",
          ...(replacesAutomationEditRoute
            ? { replaceInitialPrompt: true }
            : {}),
        },
      });
    },
    [location.pathname, navigate, pluginId],
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
