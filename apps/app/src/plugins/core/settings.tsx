import { lazy, type ComponentType } from "react";
import { definePluginApp, settings } from "@bb/plugin/app";

function page<Module, Name extends keyof Module>(
  load: () => Promise<Module>,
  name: Name,
): ComponentType {
  return lazy(async () => {
    const module = await load();
    return { default: module[name] as ComponentType };
  });
}

const view = () => import("@/views/SettingsView");

export default definePluginApp((bb) => {
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
        () => import("@/components/settings/KeyboardSettingsSection"),
        "KeyboardSettingsSection",
      ),
    },
    {
      id: "projects",
      label: "Projects",
      icon: "FolderGit",
      view: page(
        () => import("@/components/settings/ProjectsSettingsSection"),
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
        () => import("@/components/settings/PeopleSettingsSection"),
        "PeopleSettingsSection",
      ),
    },
    {
      id: "environment-variables",
      label: "Environment variables",
      icon: "Lock",
      view: page(
        () => import("@/components/settings/MachineEnvironmentSettings"),
        "MachineEnvironmentSettings",
      ),
    },
    {
      id: "plugins",
      label: "Installed plugins",
      icon: "Plug02",
      view: page(
        () => import("@/components/plugin/PluginSettings"),
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
      () => import("@/components/settings/ArchivedThreadsSettingsSection"),
      "ArchivedThreadsSettingsSection",
    ),
  });
});
