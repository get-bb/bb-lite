import { PluginSlotMount } from "@/plugins/mount";
import { usePluginSlots } from "@/plugins/registry";

export function PluginAppOverlays() {
  const { appOverlays } = usePluginSlots();
  if (appOverlays.length === 0) return null;
  return (
    <div data-bb-plugin-app-overlays="" className="contents">
      {appOverlays.map((slot) => (
        <PluginSlotMount
          key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
          pluginId={slot.pluginId}
          slotKind="appOverlay"
          slotId={slot.id}
          crashFallback={null}
        >
          <slot.component />
        </PluginSlotMount>
      ))}
    </div>
  );
}
