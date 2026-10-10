import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { AppNavRail } from "../sidebar/AppNavRail";
import { AppSidebar } from "../sidebar/AppSidebar";
import { SettingsSidebar } from "bb-plugin-settings/contract";
import { useSidebar } from "@bb/app-kit/components/ui/sidebar";

type AppLayoutSidebarMode = "app" | "settings";

export function AppLayoutSidebar({
  mode,
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  settingsRoutePath,
}: {
  mode: AppLayoutSidebarMode;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  appRoutePath: string;
  settingsRoutePath: string;
}) {
  const { isCompactViewport, isMobileSidebarClosing } = useSidebar();
  const holdCurrentMode = isCompactViewport && isMobileSidebarClosing;
  const [lastVisibleMode, setLastVisibleMode] = useState(mode);
  if (!holdCurrentMode && lastVisibleMode !== mode) {
    setLastVisibleMode(mode);
  }
  const renderedMode = holdCurrentMode ? lastVisibleMode : mode;

  return (
    <AppSidebar
      onResizeMouseDown={onResizeMouseDown}
      isResizing={isResizing}
      navRail={{
        hidden: renderedMode !== "app",
        rail: (
          <AppNavRail
            isAppMode={mode === "app"}
            isSettingsActive={mode === "settings"}
            settingsRoutePath={settingsRoutePath}
          />
        ),
        alternateBody:
          renderedMode === "settings" ? (
            <SettingsSidebar
              onResizeMouseDown={onResizeMouseDown}
              isResizing={isResizing}
              appRoutePath={appRoutePath}
              navRailHosted
            />
          ) : null,
      }}
    />
  );
}
