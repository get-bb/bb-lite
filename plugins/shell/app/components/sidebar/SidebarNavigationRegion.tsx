import { useLayoutEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { useSidebar } from "@bb/app-kit/components/ui/sidebar";
import { resetCrashedSlots } from "@bb/app-kit/plugins/registry";
import {
  readRememberedNavigationHeight,
  rememberNavigationHeight,
  SidebarNavigationPlaceholder,
} from "./SidebarNavigationPlaceholder";
import {
  sidebarNavigationProviderAtom,
  useSidebarNavigationReplacement,
} from "@bb/app-kit/components/sidebar/sidebarNavigationProvider";

export function SidebarNavigationRegion({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const replacement = useSidebarNavigationReplacement();
  const preference = useAtomValue(sidebarNavigationProviderAtom);
  const { isCompactViewport } = useSidebar();
  const [attempt, setAttempt] = useState(0);
  const navRef = useRef<HTMLElement>(null);
  const slot = replacement.kind === "plugin" ? replacement.slot : null;

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav === null || slot === null) return;
    const record = () => {
      if (nav.querySelector("[data-sidebar-navigation-placeholder]")) return;
      rememberNavigationHeight(
        preference,
        Math.round(nav.getBoundingClientRect().height),
      );
    };
    record();
    const observer = new ResizeObserver(record);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [preference, slot]);

  return (
    <nav
      ref={navRef}
      aria-label="Sidebar navigation"
      data-testid="sidebar-navigation-region"
    >
      <div className="contents">
        {slot === null ? (
          <SidebarNavigationPlaceholder
            state={
              replacement.kind === "loading"
                ? {
                    kind: "loading",
                    height: readRememberedNavigationHeight(preference),
                  }
                : { kind: "missing" }
            }
            {...(onNavigate ? { onNavigate } : {})}
          />
        ) : (
          <PluginSlotMount
            key={`${slot.pluginId}/${slot.id}/${slot.generation}/${attempt}`}
            pluginId={slot.pluginId}
            slotKind="sidebarNavigation"
            slotId={slot.id}
            crashFallback={
              <SidebarNavigationPlaceholder
                state={{
                  kind: "crashed",
                  pluginTitle: slot.title,
                  onReload: () => {
                    resetCrashedSlots(slot.pluginId);
                    setAttempt((current) => current + 1);
                  },
                }}
              />
            }
            onCrash={(pluginId) => {
              appToast.error("Sidebar navigation plugin crashed", {
                description: `${slot.title} (${pluginId}) stopped working.`,
              });
            }}
          >
            <slot.component isCompactViewport={isCompactViewport} />
          </PluginSlotMount>
        )}
      </div>
    </nav>
  );
}
