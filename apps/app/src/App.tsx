import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { QuickCreateProjectProvider } from "./hooks/useQuickCreateProject";
import { RouteNavigationProvider } from "./components/ui/app-route-anchor";
import { RouteNavigationIndicator } from "./components/ui/route-navigation-indicator";
import { UiPreferencesSync } from "@/lib/ui-preferences";
import { useAppTheme } from "./hooks/useAppTheme";
import { useFaviconColorSync } from "./lib/favicon-color-preference";
import { bootPlugins } from "@/plugins/external";
import { useRememberPluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import { useWebSocket } from "./hooks/useWebSocket";
import {
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
  getSettingsRoutePath,
} from "./lib/route-paths";
import { AppCommandProvider } from "./components/commands/AppCommandProvider";
import { RouteLoadingSkeleton } from "./components/ui/route-loading-skeleton";

const SettingsView = lazy(() =>
  import("./views/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const ProjectDetailSettingsView = lazy(() =>
  import("./views/ProjectDetailSettingsView").then((m) => ({
    default: m.ProjectDetailSettingsView,
  })),
);
const MachineSettingsView = lazy(() =>
  import("./views/MachineSettingsView").then((m) => ({
    default: m.MachineSettingsView,
  })),
);
const splitWorkspaceRouteModule = import("./views/SplitWorkspaceRoute");
splitWorkspaceRouteModule.catch(() => {});
const SplitWorkspaceRoute = lazy(() => splitWorkspaceRouteModule);

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
  const settings = <SettingsView />;

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
                <Route path={SETTINGS_ROUTE_PATH} element={settings} />
                <Route path={SETTINGS_SECTION_ROUTE_PATH} element={settings} />
                <Route path={SETTINGS_PLUGINS_ROUTE_PATH} element={settings} />
                <Route path={SETTINGS_PLUGIN_ROUTE_PATH} element={settings} />
                <Route
                  path={SETTINGS_MACHINE_ROUTE_PATH}
                  element={<MachineSettingsView />}
                />
                <Route
                  path={SETTINGS_PROJECT_ROUTE_PATH}
                  element={<ProjectDetailSettingsView />}
                />
                <Route
                  path={PROJECTLESS_ARCHIVED_ROUTE_PATH}
                  element={
                    <Navigate to={getSettingsRoutePath("archived")} replace />
                  }
                />
                <Route
                  path="*"
                  element={
                    <Suspense
                      fallback={<RouteLoadingSkeleton isBoundedPane={false} />}
                    >
                      <SplitWorkspaceRoute />
                    </Suspense>
                  }
                />
              </Routes>
            </Suspense>
          </AppLayout>
        </RouteNavigationProvider>
      </AppCommandProvider>
    </QuickCreateProjectProvider>
  );
}
