import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAtomValue } from "jotai";
import {
  PluginSlotMount,
  resetCrashedPluginSlots,
} from "@/components/plugin/PluginSlotMount";
import { appToast } from "@/components/ui/app-toast";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import {
  usePluginSlots,
  type ExperimentalSidebarNavigationSlot,
} from "@/lib/plugin-slots";
import { replacementProviderKey } from "@/lib/plugin-replacement-preference";
import { SidebarNavigationCustomize } from "./SidebarNavigationCustomize";
import {
  readRememberedNavigationHeight,
  rememberNavigationHeight,
  SidebarNavigationPlaceholder,
} from "./SidebarNavigationPlaceholder";
import {
  BUNDLED_NAVIGATION_PLUGIN_ID,
  sidebarNavigationProviderAtom,
  useSidebarNavigationReplacement,
} from "./sidebarNavigationProvider";

const SIDEBAR_NAVIGATION_SLOT_KIND = "sidebarNavigation";

const OPEN_MENU_SELECTOR = '[role="menu"]';
const OPEN_MENU_WAIT_MS = 1000;

function afterOpenMenusClose(run: () => void): () => void {
  const start = performance.now();
  let frame = 0;
  let timer = 0;
  const check = () => {
    if (
      document.querySelector(OPEN_MENU_SELECTOR) !== null &&
      performance.now() - start < OPEN_MENU_WAIT_MS
    ) {
      frame = requestAnimationFrame(check);
      return;
    }
    timer = window.setTimeout(run, 0);
  };
  check();
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function resolveCustomizeFocusReturnTarget(
  container: HTMLElement | null,
): HTMLElement | null {
  if (container === null) return null;
  const active = document.activeElement;
  if (active instanceof HTMLElement && container.contains(active)) {
    return active;
  }
  const openTrigger = container.querySelector<HTMLElement>(
    '[aria-expanded="true"], [data-state="open"]',
  );
  if (openTrigger === null) return null;
  return openTrigger.matches(FOCUSABLE_SELECTOR)
    ? openTrigger
    : openTrigger.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

function NoOriginal() {
  return null;
}

function useBundledNavigationOriginal(
  provider: ExperimentalSidebarNavigationSlot,
) {
  const { experimentalSidebarNavigations } = usePluginSlots();
  const bundled =
    provider.pluginId === BUNDLED_NAVIGATION_PLUGIN_ID
      ? undefined
      : experimentalSidebarNavigations.find(
          (slot) => slot.pluginId === BUNDLED_NAVIGATION_PLUGIN_ID,
        );
  const latest = useRef({ bundled });
  useLayoutEffect(() => {
    latest.current = { bundled };
  });
  const [Original] = useState(
    () =>
      function BundledNavigationOriginal() {
        const current = latest.current;
        if (current.bundled === undefined) return null;
        const Component = current.bundled.component;
        return (
          <PluginSlotMount
            key={`${current.bundled.pluginId}/${current.bundled.id}/${current.bundled.generation}`}
            pluginId={current.bundled.pluginId}
            slotKind={SIDEBAR_NAVIGATION_SLOT_KIND}
            slotId={current.bundled.id}
            crashFallback={<></>}
          >
            <Component
              isCompactViewport={false}
              experimental_Original={NoOriginal}
            />
          </PluginSlotMount>
        );
      },
  );
  return Original;
}

function NavigationProvider({
  slot,
  attempt,
  onReload,
}: {
  slot: ExperimentalSidebarNavigationSlot;
  attempt: number;
  onReload: () => void;
}) {
  const Original = useBundledNavigationOriginal(slot);
  const Component = slot.component;
  return (
    <PluginSlotMount
      key={`${slot.pluginId}/${slot.id}/${slot.generation}/${attempt}`}
      pluginId={slot.pluginId}
      slotKind={SIDEBAR_NAVIGATION_SLOT_KIND}
      slotId={slot.id}
      crashFallback={
        <SidebarNavigationPlaceholder
          state={{
            kind: "crashed",
            pluginTitle: slot.title,
            onReload,
          }}
        />
      }
      onCrash={(pluginId) => {
        appToast.error("Sidebar navigation plugin crashed", {
          description: `${slot.title} (${pluginId}) stopped working.`,
        });
      }}
    >
      <Component isCompactViewport={false} experimental_Original={Original} />
    </PluginSlotMount>
  );
}

export interface SidebarNavigationRegionProps {
  isCustomizing: boolean;
  onCustomizingChange: (isCustomizing: boolean) => void;
  focusReturnTargetRef: { current: HTMLElement | null };
}

export function SidebarNavigationRegion({
  isCustomizing,
  onCustomizingChange,
  focusReturnTargetRef,
}: SidebarNavigationRegionProps) {
  const replacement = useSidebarNavigationReplacement();
  const preference = useAtomValue(sidebarNavigationProviderAtom);
  const bootSettled = usePluginFrontendsSettled();
  const [attempt, setAttempt] = useState(0);
  const [isEditorShown, setEditorShown] = useState(false);
  const restoreFocusRef = useRef(false);
  const navRef = useRef<HTMLElement>(null);
  const slot = replacement.kind === "plugin" ? replacement.registration : null;
  const providerKey = slot ? replacementProviderKey(slot) : null;

  useEffect(() => {
    if (!isCustomizing) {
      setEditorShown(false);
      return;
    }
    return afterOpenMenusClose(() => setEditorShown(true));
  }, [isCustomizing]);

  useLayoutEffect(() => {
    if (isCustomizing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const target = focusReturnTargetRef.current;
    focusReturnTargetRef.current = null;
    if (target?.isConnected) {
      target.focus();
      return;
    }
    const nav = navRef.current;
    const scope = nav?.closest<HTMLElement>('[data-sidebar="sidebar"]') ?? null;
    const fallback =
      nav?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      scope?.querySelector<HTMLElement>(
        `[data-sidebar-header-slot] :is(${FOCUSABLE_SELECTOR})`,
      ) ??
      null;
    fallback?.focus();
  }, [focusReturnTargetRef, isCustomizing]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav === null || providerKey === null || isCustomizing) return;
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
  }, [isCustomizing, preference, providerKey]);

  const handleReload = useCallback(() => {
    if (slot !== null) resetCrashedPluginSlots(slot.pluginId);
    setAttempt((current) => current + 1);
  }, [slot]);

  return (
    <nav
      ref={navRef}
      aria-label="Sidebar navigation"
      data-testid="sidebar-navigation-region"
    >
      {isCustomizing && isEditorShown ? (
        <SidebarNavigationCustomize
          onClose={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            onCustomizingChange(false);
          }}
        />
      ) : null}
      <div
        hidden={isCustomizing || undefined}
        className={isCustomizing ? undefined : "contents"}
      >
        {slot === null ? (
          <SidebarNavigationPlaceholder
            state={
              bootSettled
                ? { kind: "missing" }
                : {
                    kind: "loading",
                    height: readRememberedNavigationHeight(preference),
                  }
            }
          />
        ) : (
          <NavigationProvider
            slot={slot}
            attempt={attempt}
            onReload={handleReload}
          />
        )}
      </div>
    </nav>
  );
}
