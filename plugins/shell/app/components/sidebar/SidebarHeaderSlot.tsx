import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "@bb/shared-ui/lib/utils";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { useSidebar } from "@bb/app-kit/components/ui/sidebar";
import { useSidebarHeaderReplacement } from "@bb/app-kit/components/sidebar/sidebarHeaderProvider";

const DEFAULT_CONTROL_SIZE = 28;

export function SidebarHeaderSlot({
  startInsetClassName,
}: {
  startInsetClassName: string;
}) {
  const replacement = useSidebarHeaderReplacement();
  const { isCompactViewport } = useSidebar();
  const slotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({
    width: 0,
    controlSize: DEFAULT_CONTROL_SIZE,
  });
  const isActive = replacement.kind === "plugin";

  useLayoutEffect(() => {
    const element = slotRef.current;
    if (!isActive || element === null) return;
    const measure = (width: number) => {
      const value = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--bb-sidebar-control-size"),
      );
      const controlSize =
        Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTROL_SIZE;
      setSize((current) =>
        current.width === width && current.controlSize === controlSize
          ? current
          : { width, controlSize },
      );
    };
    const style = getComputedStyle(element);
    measure(
      Math.floor(
        element.clientWidth -
          (Number.parseFloat(style.paddingLeft) || 0) -
          (Number.parseFloat(style.paddingRight) || 0),
      ),
    );
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) flushSync(() => measure(Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isActive, isCompactViewport]);

  if (replacement.kind !== "plugin") return null;
  const slot = replacement.slot;
  return (
    <div
      ref={slotRef}
      data-testid="sidebar-header-slot"
      data-sidebar-header-slot=""
      className={cn(
        "flex h-full min-w-0 flex-1 items-center overflow-hidden",
        startInsetClassName,
      )}
    >
      <PluginSlotMount
        key={`${slot.pluginId}/${slot.id}`}
        pluginId={slot.pluginId}
        slotKind="sidebarHeader"
        slotId={slot.id}
        crashFallback={null}
        onCrash={(pluginId) => {
          appToast.error("Sidebar header plugin crashed", {
            description: `${slot.title} (${pluginId}) stopped working, so bb removed it from the sidebar header.`,
          });
        }}
      >
        <slot.view
          width={size.width}
          controlSize={size.controlSize}
          isCompactViewport={isCompactViewport}
        />
      </PluginSlotMount>
    </div>
  );
}
