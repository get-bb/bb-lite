import type { MouseEvent as ReactMouseEvent } from "react";
import type { IconName } from "@bb/shared-ui/icon";
import { PluginIcon } from "@bb/app-kit/components/plugin/PluginIcon";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarLabel,
  SectionSidebarRow,
} from "@bb/app-kit/components/sidebar/SectionSidebar";
import { getPluginConfigurationRoutePath } from "@bb/app-kit/lib/route-paths";
import { useSettingsNavState } from "./settings-nav";
import {
  getSettingsSectionRoutePath,
  useSettingsPages,
  type SettingsNavSection,
} from "@bb/app-kit/components/settings/settings-sections";

export function SettingsSidebar({
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  navRailHosted = false,
}: {
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  appRoutePath: string;
  navRailHosted?: boolean;
}) {
  const { activePluginId, activeSection, pluginEntries } =
    useSettingsNavState();
  const pages = useSettingsPages();
  const sectionRow = (section: SettingsNavSection) => (
    <SectionSidebarRow
      key={section.id}
      active={activeSection === section.id}
      label={section.label}
      to={getSettingsSectionRoutePath(section.id)}
    >
      <SectionSidebarIcon name={section.icon as IconName} />
    </SectionSidebarRow>
  );
  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      isResizing={isResizing}
      navRailHosted={navRailHosted}
      onResizeMouseDown={onResizeMouseDown}
      testIdPrefix="settings"
    >
      {navRailHosted ? null : (
        <SectionSidebarLabel>Settings</SectionSidebarLabel>
      )}
      <div className="mt-1 space-y-0.5">
        {pages.filter((page) => page.group !== "archived").map(sectionRow)}
      </div>
      {pluginEntries.length > 0 ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Plugins</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {pluginEntries.map((entry) => (
              <SectionSidebarRow
                key={entry.id}
                active={activePluginId === entry.id}
                label={entry.label}
                to={getPluginConfigurationRoutePath({ pluginId: entry.id })}
              >
                <PluginIcon
                  pluginId={entry.id}
                  icon={entry.icon}
                  compactIconUrl={entry.compactIconUrl}
                  className="size-4 shrink-0"
                />
              </SectionSidebarRow>
            ))}
          </div>
        </>
      ) : null}
      <div className="mt-4">
        <SectionSidebarLabel>Archived</SectionSidebarLabel>
      </div>
      <div className="mt-1 space-y-0.5">
        {pages.filter((page) => page.group === "archived").map(sectionRow)}
      </div>
    </SectionSidebar>
  );
}
