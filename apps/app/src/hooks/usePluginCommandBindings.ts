import { useMemo } from "react";
import {
  applyAppKeybindingOverrides,
  pluginCommandId,
  type AppDefaultKeybindings,
  type AppKeybindingOverrides,
} from "@bb/domain";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { usePluginSlots } from "@/plugins/registry";
import { browserPlatform } from "@/lib/app-keybindings";
import { resolvePluginCommandDefaults } from "@/lib/plugin-command-keybindings";

const EMPTY_DEFAULTS: AppDefaultKeybindings = [];
const EMPTY_OVERRIDES: AppKeybindingOverrides = [];

export function usePluginCommandBindings() {
  const { data } = useSystemConfig();
  const { commands } = usePluginSlots();
  const builtInDefaults = data?.defaultKeybindings ?? EMPTY_DEFAULTS;
  const overrides = data?.keybindingOverrides ?? EMPTY_OVERRIDES;
  const platform = browserPlatform();
  return useMemo(() => {
    const pluginDefaults: AppDefaultKeybindings = commands.map((command) => ({
      command: pluginCommandId(command.pluginId, command.id),
      desktopOnly: false,
      shortcut:
        command.defaultShortcut === undefined
          ? null
          : {
              key: command.defaultShortcut.key,
              mod: command.defaultShortcut.mod ?? false,
              meta: command.defaultShortcut.meta ?? false,
              control: command.defaultShortcut.control ?? false,
              alt: command.defaultShortcut.alt ?? false,
              shift: command.defaultShortcut.shift ?? false,
            },
      when: { all: ["mainSurface"], none: ["modalOpen"] },
    }));
    const resolved = resolvePluginCommandDefaults(
      [...builtInDefaults, ...pluginDefaults],
      overrides,
      platform,
    );
    const pluginIds = new Set(pluginDefaults.map((binding) => binding.command));
    return {
      ...resolved,
      commands,
      keybindings: [
        ...(data?.keybindings ?? []),
        ...applyAppKeybindingOverrides(
          resolved.defaults.filter((binding) => pluginIds.has(binding.command)),
          overrides,
        ),
      ],
    };
  }, [
    builtInDefaults,
    commands,
    data?.keybindings,
    overrides,
    platform,
  ]);
}
