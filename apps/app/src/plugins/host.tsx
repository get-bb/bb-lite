import { describeKernel, server, threads } from "@bb/plugin/app";
import {
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  BbContext,
  BbNavigate,
  Live,
  Op,
  OpState,
  PluginAppHost,
  EnvironmentProvidersState,
  ProvidersState,
  SettingsState,
} from "@bb/plugin/app";
import { Icon } from "@bb/shared-ui/icon";
import { useQuestionFormHost } from "@bb/shared-ui/question-form-host";
import { ImageLightbox } from "@bb/app-kit/components/ui/image-lightbox";
import {
  PluginDiff,
  PluginFileLink,
  PluginMarkdown,
} from "@bb/app-kit/components/plugin/PluginContent";
import { ThreadViewers } from "@bb/app-kit/components/users/ThreadViewers";
import { PluginUrlLink } from "@bb/app-kit/components/plugin/PluginUrlLink";
import { ProviderIcon } from "@bb/app-kit/components/plugin/ProviderIcon";
import { usePluginThreadPanelOpenHandler } from "@bb/app-kit/components/plugin/plugin-thread-panel-navigation";
import { useSystemEnvironmentProviders } from "@bb/app-kit/hooks/queries/environment-provider-queries";
import { usePluginSettingsView } from "@bb/app-kit/hooks/queries/plugin-settings-queries";
import { useSystemProviders } from "@bb/app-kit/hooks/queries/system-queries";
import { useRouteState } from "@bb/app-kit/hooks/useRouteState";
import { useServerConnectionState } from "@bb/app-kit/hooks/useServerConnectionState";
import { useAppNavigationHost } from "@bb/app-kit/lib/url-open-routing";
import {
  getPluginPanelRoutePath,
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
} from "@bb/app-kit/lib/route-paths";
import { wsManager } from "@bb/app-kit/lib/ws";
import { useCodeTheme } from "@bb/app-kit/lib/code-theme-registration";
import { requestFileOpen } from "@bb/app-kit/lib/file-open-requests";
import { PluginContext, usePluginId } from "@bb/app-kit/plugins/context";
import { readLive } from "@bb/app-kit/plugins/ops";
import { appKernel, callOp } from "@bb/app-kit/plugins/registry";
import {
  SlotMount,
  useSlot,
  useSlotEntries,
  useSlotEntry,
} from "@bb/app-kit/plugins/slots";

export const OP_QUERY_KEY = "op";

function useOp<O extends Op>(
  op: O,
  input: unknown,
  options: { enabled?: boolean } = {},
): OpState<never> {
  const plugin = useContext(PluginContext) ?? undefined;
  const query = useQuery({
    queryKey: [OP_QUERY_KEY, op.name, input],
    queryFn: ({ signal }) => callOp(op, input as never, { signal, plugin }),
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
  const plugin = useContext(PluginContext) ?? undefined;
  return useCallback(
    (input: unknown) =>
      callOp(op, input as never, { plugin }) as Promise<never>,
    [op, plugin],
  );
}

function useLive<L extends Live>(live: L) {
  const query = useQuery({
    queryKey: [OP_QUERY_KEY, live.name],
    queryFn: () => readLive(live),
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

function useSettings(options?: { projectId?: string }): SettingsState {
  const query = usePluginSettingsView(usePluginId(), {
    enabled: true,
    projectId: options?.projectId,
  });
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
const NO_FLAGS: Readonly<Record<string, boolean>> = {};

function useExperiments(): Readonly<Record<string, boolean>> {
  const read: OpState<{ flags: Record<string, boolean> }> = useOp(
    server.experiments,
    {},
  );
  return read.data?.flags ?? NO_FLAGS;
}

function useProviders(): ProvidersState {
  const query = useSystemProviders();
  const providers = query.data;
  return useMemo<ProvidersState>(
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

function useEnvironmentProviders(): EnvironmentProvidersState {
  const { providers } = useSystemEnvironmentProviders();
  return useMemo<EnvironmentProvidersState>(
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
        void callOp(threads.get, { threadId })
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
      openFile: ({ threadId, path, source }) =>
        requestFileOpen(threadId, path, source),
    }),
    [appNavigation, navigate, openThreadPanelHandler, pluginId],
  );
}

export const pluginAppHost: PluginAppHost = {
  createElement,
  use: (slot) => appKernel().use(slot),
  useRealtimeConnectionState: useServerConnectionState,
  useSettings,
  useExperiments,
  usePluginId,
  useBbContext,
  useBbNavigate,
  useCodeTheme,
  useProviders,
  useEnvironmentProviders,
  useQuestionFormHost,
  useSlot,
  useSlotEntries,
  useSlotEntry,
  useOp,
  useCall,
  useLive,
  useChanged,
  callOp,
  describeApp: (contractId) => describeKernel(appKernel(), contractId),
  SlotMount,
  Icon,
  ProviderIcon,
  UrlLink: PluginUrlLink,
  ThreadViewers,
  ImageLightbox,
  Markdown: PluginMarkdown,
  Diff: PluginDiff,
  FileLink: PluginFileLink,
};
