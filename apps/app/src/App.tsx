import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { QuickCreateProjectProvider } from "./hooks/useQuickCreateProject";
import { RouteNavigationProvider } from "./components/ui/app-route-anchor";
import { RouteNavigationIndicator } from "./components/ui/route-navigation-indicator";
import { AppNavigationUrlHost } from "./lib/url-open-routing";
import { UiPreferencesSync } from "@/lib/ui-preferences/UiPreferencesSync";
import { AppFileExternalNavigationHost } from "./components/plugin/AppFileExternalNavigationHost";
import { useAppTheme } from "./hooks/useAppTheme";
import { useFaviconColorSync } from "./lib/favicon-color-preference";
import { usePluginFrontendBoot } from "./hooks/usePluginFrontendBoot";
import { markRouteContentPainted } from "./lib/route-content-paint";
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
  import("./views/SettingsView").then((m) => ({
    default: m.SettingsView,
  })),
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

function hashTargetId(hash: string): string | null {
  if (hash.length <= 1) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

const HASH_NAVIGATION_WAIT_MS = 2_000;

export function HashNavigationScroll() {
  const location = useLocation();

  useEffect(() => {
    const targetId = hashTargetId(location.hash);
    if (targetId === null) return;

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

    let observer: MutationObserver | null = null;
    let timeoutId: number | null = null;
    const stopWaiting = () => {
      observer?.disconnect();
      observer = null;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
    observer = new MutationObserver(() => {
      if (scrollToTarget()) stopWaiting();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = window.setTimeout(stopWaiting, HASH_NAVIGATION_WAIT_MS);
    return stopWaiting;
  }, [location.hash, location.key]);

  return null;
}

export function AppRoutes() {
  return (
    <AppLayout>
      <Suspense fallback={null}>
        <Routes>
          <Route path={SETTINGS_ROUTE_PATH} element={<SettingsView />} />
          <Route
            path={SETTINGS_SECTION_ROUTE_PATH}
            element={<SettingsView />}
          />
          <Route
            path={SETTINGS_PLUGINS_ROUTE_PATH}
            element={<SettingsView />}
          />
          <Route path={SETTINGS_PLUGIN_ROUTE_PATH} element={<SettingsView />} />
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
            element={<Navigate to={getSettingsRoutePath("archived")} replace />}
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
        <RouteContentPaintSignal />
      </Suspense>
    </AppLayout>
  );
}

function RouteContentPaintSignal() {
  useEffect(() => {
    markRouteContentPainted();
  }, []);
  return null;
}

export function App() {
  useWebSocket();
  useAppTheme();
  useFaviconColorSync();
  usePluginFrontendBoot();
  useRememberPluginNavPanelChrome();

  return (
    <QuickCreateProjectProvider>
      <AppCommandProvider>
        <RouteNavigationProvider>
          <RouteNavigationIndicator />
          <AppNavigationUrlHost>
            <AppFileExternalNavigationHost>
              <HashNavigationScroll />
              <UiPreferencesSync />
              <AppRoutes />
            </AppFileExternalNavigationHost>
          </AppNavigationUrlHost>
        </RouteNavigationProvider>
      </AppCommandProvider>
    </QuickCreateProjectProvider>
  );
}
