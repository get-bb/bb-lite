import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { AppNavRail } from "@/components/sidebar/AppNavRail";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { Sidebar, useSidebar } from "@/components/ui/sidebar.js";

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

  if (isCompactViewport) {
    return (
      <Sidebar>
        <AppSidebar
          onResizeMouseDown={onResizeMouseDown}
          isResizing={isResizing}
          settingsRoutePath={settingsRoutePath}
          mobileHosted={{ hidden: renderedMode !== "app" }}
        />
        {renderedMode === "settings" ? (
          <SettingsSidebar
            onResizeMouseDown={onResizeMouseDown}
            isResizing={isResizing}
            appRoutePath={appRoutePath}
          />
        ) : null}
      </Sidebar>
    );
  }

  return (
    <AppSidebar
      onResizeMouseDown={onResizeMouseDown}
      isResizing={isResizing}
      settingsRoutePath={settingsRoutePath}
      navRail={{
        hidden: renderedMode !== "app",
        rail: (
          <AppNavRail
            isAppMode={renderedMode === "app"}
            isSettingsActive={renderedMode === "settings"}
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
