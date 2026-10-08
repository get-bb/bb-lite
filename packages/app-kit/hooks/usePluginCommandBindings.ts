import { useMemo } from "react";
import {
  applyAppKeybindingOverrides,
  pluginCommandId,
  type AppDefaultKeybindings,
  type AppKeybindingOverrides,
} from "@bb/domain";
import { useSystemConfig } from "./queries/system-queries";
import { usePluginSlots } from "../plugins/registry";
import {
  browserPlatform,
  resolvePluginCommandDefaults,
} from "../lib/app-keybindings";

const NO_DEFAULTS: AppDefaultKeybindings = [];
const NO_OVERRIDES: AppKeybindingOverrides = [];

export function usePluginCommandBindings() {
  const { data } = useSystemConfig();
  const { commands } = usePluginSlots();
  const builtInDefaults = data?.defaultKeybindings ?? NO_DEFAULTS;
  const builtInBindings = data?.keybindings;
  const overrides = data?.keybindingOverrides ?? NO_OVERRIDES;
  return useMemo(() => {
    const pluginDefaults: AppDefaultKeybindings = commands.map(
      ({ pluginId, id, defaultShortcut: shortcut }) => ({
        command: pluginCommandId(pluginId, id),
        shortcut:
          shortcut === undefined
            ? null
            : {
                key: shortcut.key,
                mod: shortcut.mod ?? false,
                meta: shortcut.meta ?? false,
                control: shortcut.control ?? false,
                alt: shortcut.alt ?? false,
                shift: shortcut.shift ?? false,
              },
        when: { all: ["mainSurface"], none: ["modalOpen"] },
      }),
    );
    const resolved = resolvePluginCommandDefaults(
      [...builtInDefaults, ...pluginDefaults],
      overrides,
      browserPlatform(),
    );
    return {
      ...resolved,
      commands,
      keybindings: [
        ...(builtInBindings ?? []),
        ...applyAppKeybindingOverrides(
          resolved.defaults.slice(builtInDefaults.length),
          overrides,
        ),
      ],
    };
  }, [builtInBindings, builtInDefaults, commands, overrides]);
}
