import { part } from "@bb/app-kit/plugins/parts";
import type * as SettingsSidebarModule from "./app/components/settings/SettingsSidebar";

export const SettingsSidebar = part<
  typeof SettingsSidebarModule.SettingsSidebar
>("settings", "SettingsSidebar");
