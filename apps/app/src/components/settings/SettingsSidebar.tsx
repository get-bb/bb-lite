import { type MouseEvent as ReactMouseEvent } from "react";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarLabel,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import { useSettingsNavState } from "./settings-nav";
import type { SettingsNavState } from "./settings-nav";
import { getSettingsSectionRoutePath } from "./settings-sections";

interface SettingsSidebarProps {
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  appRoutePath: string;
}

type SettingsSidebarNavigation = Pick<
  SettingsNavState,
  "activePluginId" | "activeSection" | "pluginEntries" | "sections"
>;

interface SettingsSidebarContentProps extends SettingsSidebarProps {
  navigation: SettingsSidebarNavigation;
  testIdPrefix?: string;
}

export function SettingsSidebarContent({
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  navigation,
  testIdPrefix = "settings",
}: SettingsSidebarContentProps) {
  const { activePluginId, activeSection, pluginEntries, sections } = navigation;
  const hasPlugins = pluginEntries.length > 0;

  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      isResizing={isResizing}
      onResizeMouseDown={onResizeMouseDown}
      testIdPrefix={testIdPrefix}
    >
      <SectionSidebarLabel>Settings</SectionSidebarLabel>
      <div className="mt-1 space-y-0.5">
        {sections
          .filter((section) => section.id !== "archived")
          .map((section) => (
            <SectionSidebarRow
              key={section.id}
              active={activeSection === section.id}
              label={section.label}
              to={getSettingsSectionRoutePath(section.id)}
            >
              <SectionSidebarIcon name={section.icon} />
            </SectionSidebarRow>
          ))}
      </div>
      {hasPlugins ? (
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
                  className="size-4 shrink-0"
                />
              </SectionSidebarRow>
            ))}
          </div>
        </>
      ) : null}
      {sections.some((section) => section.id === "archived") ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Archived</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {sections
              .filter((section) => section.id === "archived")
              .map((section) => (
                <SectionSidebarRow
                  key={section.id}
                  active={activeSection === section.id}
                  label={section.label}
                  to={getSettingsSectionRoutePath(section.id)}
                >
                  <SectionSidebarIcon name={section.icon} />
                </SectionSidebarRow>
              ))}
          </div>
        </>
      ) : null}
    </SectionSidebar>
  );
}

export function SettingsSidebar({
  onResizeMouseDown,
  isResizing,
  appRoutePath,
}: SettingsSidebarProps) {
  const navigation = useSettingsNavState();

  return (
    <SettingsSidebarContent
      appRoutePath={appRoutePath}
      isResizing={isResizing}
      navigation={navigation}
      onResizeMouseDown={onResizeMouseDown}
    />
  );
}
