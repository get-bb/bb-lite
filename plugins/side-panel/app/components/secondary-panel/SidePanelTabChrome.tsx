import { Suspense } from "react";
import {
  sidePanel,
  type SidePanelTab,
  type SidePanelTabIconProps,
  type SidePanelTabKind,
  type SidePanelTabProps,
} from "@bb/plugin/app";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { PluginItemIcon } from "@bb/app-kit/components/plugin/PluginIcon";
import { usePluginSlots } from "@bb/app-kit/plugins/registry";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import {
  useSlot,
  useSlotEntries,
  useSlotEntry,
} from "@bb/app-kit/plugins/slots";
import { RightPanelFileTabIcon } from "./RightPanelFileTabIcon";

export function findSidePanelTabKind(
  kinds: readonly SidePanelTabKind[],
  kind: string,
): SidePanelTabKind | null {
  return kinds.filter((item) => item.kind === kind).at(-1) ?? null;
}

export function useSidePanelTabKinds(): readonly SidePanelTabKind[] {
  return useSlot(sidePanel.tab);
}

export function SidePanelTabIcon({ tab }: SidePanelTabIconProps) {
  const TabIcon = useSlotEntry(sidePanel.tab, tab.kind)?.icon;
  return TabIcon === undefined ? null : <TabIcon tab={tab} />;
}

export function SidePanelTabBody(props: SidePanelTabProps) {
  const kind = props.tab.kind;
  const entry = useSlotEntry(sidePanel.tab, kind);
  const entries = useSlotEntries(sidePanel.tab);
  if (entry === null) return null;
  const View = entry.view;
  return (
    <PluginSlotMount
      pluginId={entries.find(({ item }) => item === entry)?.plugin ?? "bb"}
      slotKind={sidePanel.tab.name}
      slotId={kind}
      instanceId={props.tab.id}
    >
      <Suspense fallback={null}>
        <View {...props} />
      </Suspense>
    </PluginSlotMount>
  );
}

export function fileTabTitle(tab: SidePanelTab): string {
  if (!("path" in tab)) return tab.kind;
  return tab.path.split("/").at(-1) ?? tab.path;
}

export function FileTabIcon({ tab }: SidePanelTabIconProps) {
  return "path" in tab ? <RightPanelFileTabIcon path={tab.path} /> : null;
}

export function TerminalTabIcon() {
  return (
    <Icon
      name="Terminal"
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
      aria-hidden
    />
  );
}

export function NewTabIcon() {
  return (
    <Icon
      name="NewTab"
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
      aria-hidden
    />
  );
}

export function pluginPanelTabTitle(tab: SidePanelTab): string {
  return tab.kind === "plugin-panel" ? tab.title : tab.kind;
}

export function PluginPanelTabIcon({ tab }: SidePanelTabIconProps) {
  const { threadPanels } = usePluginSlots();
  if (tab.kind !== "plugin-panel") return null;
  const action = threadPanels.find(
    (item) => item.pluginId === tab.pluginId && item.id === tab.actionId,
  );
  return (
    <PluginItemIcon
      pluginId={tab.pluginId}
      icon={action?.icon ?? null}
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
    />
  );
}
