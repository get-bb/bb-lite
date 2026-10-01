import { type MouseEvent as ReactMouseEvent } from "react";
import { useSidebarThreadReveal } from "@/components/sidebar/useSidebarThreadReveal";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";

export type AppLayoutSidebarMode = "app" | "settings";

interface AppLayoutSidebarProps {
  mode: AppLayoutSidebarMode;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  appRoutePath: string;
  settingsRoutePath: string;
}

export function AppLayoutSidebar({
  mode,
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  settingsRoutePath,
}: AppLayoutSidebarProps) {
  useSidebarThreadReveal();

  if (mode === "settings") {
    return (
      <SettingsSidebar
        onResizeMouseDown={onResizeMouseDown}
        isResizing={isResizing}
        appRoutePath={appRoutePath}
      />
    );
  }

  return (
    <AppSidebar
      onResizeMouseDown={onResizeMouseDown}
      isResizing={isResizing}
      settingsRoutePath={settingsRoutePath}
    />
  );
}
