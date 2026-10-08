import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { app } from "@bb/plugin/app";
import { QuickCreateProjectProvider } from "@bb/app-kit/hooks/useQuickCreateProject";
import { RouteNavigationProvider } from "@bb/app-kit/components/ui/app-route-anchor";
import { RouteNavigationIndicator } from "@bb/app-kit/components/ui/route-navigation-indicator";
import { UiPreferencesSync } from "@bb/app-kit/lib/ui-preferences";
import { useAppTheme } from "@bb/app-kit/hooks/useAppTheme";
import { useFaviconColorSync } from "@bb/app-kit/lib/favicon-color-preference";
import { bootPlugins } from "./plugins/external";
import { useSlot } from "@bb/app-kit/plugins/slots";
import { useRememberPluginNavPanelChrome } from "@bb/app-kit/lib/plugin-nav-panel-chrome";
import { useWebSocket } from "@bb/app-kit/hooks/useWebSocket";
import { AppCommandProvider } from "@bb/app-kit/components/commands/AppCommandProvider";

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
  const Root = useSlot(app.root).at(-1);

  return (
    <QuickCreateProjectProvider>
      <AppCommandProvider>
        <RouteNavigationProvider>
          <RouteNavigationIndicator />
          <HashNavigationScroll />
          <UiPreferencesSync />
          {Root === undefined ? null : <Root />}
        </RouteNavigationProvider>
      </AppCommandProvider>
    </QuickCreateProjectProvider>
  );
}
