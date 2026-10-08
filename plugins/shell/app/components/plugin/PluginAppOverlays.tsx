import { shell } from "@bb/plugin/app";
import { useOwned } from "@bb/app-kit/plugins/slots";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";

export function PluginAppOverlays() {
  const appOverlays = useOwned(shell.overlay);
  if (appOverlays.length === 0) return null;
  return (
    <div data-bb-plugin-app-overlays="" className="contents">
      {appOverlays.map((slot) => (
        <PluginSlotMount
          key={`${slot.pluginId}/${slot.id}`}
          pluginId={slot.pluginId}
          slotKind="appOverlay"
          slotId={slot.id}
          crashFallback={null}
        >
          <slot.view />
        </PluginSlotMount>
      ))}
    </div>
  );
}
