import type { PluginSlot } from "@/plugins/registry";
import { getPluginPanelRoutePath } from "@/lib/route-paths";
import type { PaletteAction } from "./palette-action";

interface BuildPluginPagePaletteActionsArgs {
  navigate: (path: string) => void;
  panels: readonly PluginSlot<"navPanels">[];
}

export function buildPluginPagePaletteActions(
  args: BuildPluginPagePaletteActionsArgs,
): PaletteAction[] {
  return args.panels.map((panel) => ({
    id: `plugin-page:${panel.pluginId}/${panel.id}`,
    bucket: "Plugins" as const,
    group: "Plugin pages",
    title: panel.title,
    shortcut: null,
    run: () =>
      args.navigate(
        getPluginPanelRoutePath({
          pluginId: panel.pluginId,
          path: panel.path,
        }),
      ),
  }));
}
