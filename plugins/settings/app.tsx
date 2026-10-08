import { lazy, type ComponentType } from "react";
import {
  app,
  settings,
  shell,
  type ShellRoute,
  type PluginAppApi,
} from "@bb/plugin/app";
import {
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
} from "@bb/app-kit/lib/route-paths";
import * as parts from "./parts";

function page<Module, Name extends keyof Module>(
  load: () => Promise<Module>,
  name: Name,
): ComponentType {
  return lazy(async () => {
    const module = await load();
    return { default: module[name] as ComponentType };
  });
}

const view = () => import("./app/views/SettingsView");

const SettingsView = lazy(() =>
  import("./app/views/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const ProjectDetailSettingsView = lazy(() =>
  import("./app/views/ProjectDetailSettingsView").then((m) => ({
    default: m.ProjectDetailSettingsView,
  })),
);
const MachineSettingsView = lazy(() =>
  import("./app/views/MachineSettingsView").then((m) => ({
    default: m.MachineSettingsView,
  })),
);

const ROUTES: readonly ShellRoute[] = [
  { id: "settings", path: SETTINGS_ROUTE_PATH, view: SettingsView },
  {
    id: "settings-section",
    path: SETTINGS_SECTION_ROUTE_PATH,
    view: SettingsView,
  },
  {
    id: "settings-plugins",
    path: SETTINGS_PLUGINS_ROUTE_PATH,
    view: SettingsView,
  },
  {
    id: "settings-plugin",
    path: SETTINGS_PLUGIN_ROUTE_PATH,
    view: SettingsView,
  },
  {
    id: "settings-machine",
    path: SETTINGS_MACHINE_ROUTE_PATH,
    view: MachineSettingsView,
  },
  {
    id: "settings-project",
    path: SETTINGS_PROJECT_ROUTE_PATH,
    view: ProjectDetailSettingsView,
  },
];

export default function settingsApp(bb: PluginAppApi): void {
  bb.add(app.parts, { plugin: "settings", parts });
  for (const route of ROUTES) bb.add(shell.route, route);
  const pages = [
    {
      id: "general",
      label: "General",
      icon: "Settings",
      view: page(view, "GeneralSettingsPage"),
    },
    {
      id: "providers",
      label: "Providers",
      icon: "Bot",
      view: page(view, "ProvidersSettingsPage"),
    },
    {
      id: "appearance",
      label: "Appearance",
      icon: "Palette",
      view: page(view, "AppearanceSettingsPage"),
    },
    {
      id: "keyboard",
      label: "Keyboard",
      icon: "SlidersHorizontal",
      view: page(
        () => import("./app/components/settings/KeyboardSettingsSection"),
        "KeyboardSettingsSection",
      ),
    },
    {
      id: "projects",
      label: "Projects",
      icon: "FolderGit",
      view: page(
        () => import("./app/components/settings/ProjectsSettingsSection"),
        "ProjectsSettingsSection",
      ),
    },
    {
      id: "machines",
      label: "Machines",
      icon: "Laptop",
      view: page(view, "MachinesSettingsPage"),
    },
    {
      id: "people",
      label: "People",
      icon: "UserRound",
      view: page(
        () => import("./app/components/settings/PeopleSettingsSection"),
        "PeopleSettingsSection",
      ),
    },
    {
      id: "environment-variables",
      label: "Environment variables",
      icon: "Lock",
      view: page(
        () => import("./app/components/settings/MachineEnvironmentSettings"),
        "MachineEnvironmentSettings",
      ),
    },
    {
      id: "plugins",
      label: "Installed plugins",
      icon: "Plug02",
      view: page(
        () => import("./app/components/plugin/PluginSettings"),
        "InstalledPluginsSettingsSection",
      ),
    },
  ];
  pages.forEach((entry, index) => {
    bb.add(settings.page, { ...entry, order: index * 10 });
  });
  bb.add(settings.page, {
    id: "archived",
    label: "Archived threads",
    icon: "Archive",
    group: "archived",
    order: 900,
    view: page(
      () => import("./app/components/settings/ArchivedThreadsSettingsSection"),
      "ArchivedThreadsSettingsSection",
    ),
  });
}
