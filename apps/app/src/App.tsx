import { Suspense, useEffect, useMemo } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { shell, type ShellRoute, type SlotEntryView } from "@bb/plugin/app";
import { AppLayout } from "./components/layout/AppLayout";
import { QuickCreateProjectProvider } from "./hooks/useQuickCreateProject";
import { RouteNavigationProvider } from "./components/ui/app-route-anchor";
import { RouteNavigationIndicator } from "./components/ui/route-navigation-indicator";
import { UiPreferencesSync } from "@/lib/ui-preferences";
import { useAppTheme } from "./hooks/useAppTheme";
import { useFaviconColorSync } from "./lib/favicon-color-preference";
import { bootPlugins } from "@/plugins/external";
import { SlotMount, useSlotEntries } from "@/plugins/slots";
import { useRememberPluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import { useWebSocket } from "./hooks/useWebSocket";
import { AppCommandProvider } from "./components/commands/AppCommandProvider";

const CORE_PLUGIN_ID = "shell";
const UNORDERED = 1_000;

type RouteEntry = SlotEntryView<ShellRoute>;

function ordered(entries: readonly RouteEntry[]): RouteEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Number(a.entry.item.path === "*") - Number(b.entry.item.path === "*") ||
        (a.entry.item.order ?? UNORDERED) - (b.entry.item.order ?? UNORDERED) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

function useShellRoutes(): readonly RouteEntry[] {
  const entries = useSlotEntries(shell.route);
  return useMemo(() => ordered(entries), [entries]);
}

function ShellRouteElement({ plugin, item }: RouteEntry) {
  const View = item.view;
  if (plugin === CORE_PLUGIN_ID) return <View />;
  return (
    <SlotMount pluginId={plugin} slot={shell.route.name} id={item.id}>
      <View />
    </SlotMount>
  );
}

function HashNavigationScroll() {
  const location = useLocation();
  useEffect(() => {
    if (location.hash.length <= 1) return;
    let targetId = location.hash.slice(1);
    try {
      targetId = decodeURIComponent(targetId);
    } catch {}
    const scrollToTarget = (): boolean => {
      const target = document.getElementById(targetId);
      if (target === null) return false;
      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
        target.tabIndex = -1;
      }
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start", inline: "nearest" });
      return true;
    };
    if (scrollToTarget()) return;
    const observer = new MutationObserver(() => {
      if (scrollToTarget()) stopWaiting();
    });
    const timeoutId = window.setTimeout(() => observer.disconnect(), 2_000);
    const stopWaiting = () => {
      observer.disconnect();
      window.clearTimeout(timeoutId);
    };
    observer.observe(document.body, { childList: true, subtree: true });
    return stopWaiting;
  }, [location.hash, location.key]);
  return null;
}

export function App() {
  useWebSocket();
  useAppTheme();
  useFaviconColorSync();
  useEffect(() => {
    void bootPlugins();
  }, []);
  useRememberPluginNavPanelChrome();
  const routes = useShellRoutes();

  return (
    <QuickCreateProjectProvider>
      <AppCommandProvider>
        <RouteNavigationProvider>
          <RouteNavigationIndicator />
          <HashNavigationScroll />
          <UiPreferencesSync />
          <AppLayout>
            <Suspense fallback={null}>
              <Routes>
                {routes.map((entry) => (
                  <Route
                    key={entry.item.id}
                    path={entry.item.path}
                    element={<ShellRouteElement {...entry} />}
                  />
                ))}
              </Routes>
            </Suspense>
          </AppLayout>
        </RouteNavigationProvider>
      </AppCommandProvider>
    </QuickCreateProjectProvider>
  );
}
