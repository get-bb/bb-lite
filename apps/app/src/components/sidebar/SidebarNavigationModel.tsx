import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useStore } from "jotai";
import type {
  SidebarNavigationActions,
  SidebarNavigationIconProps,
  SidebarNavigationItem,
  SidebarNavigationState,
} from "@bb/plugin/app";
import { Icon } from "@bb/shared-ui/icon";
import {
  useAppCommandRunner,
  useAppCommandShortcut,
  useIsAppCommandModifierHeld,
} from "@/components/commands/AppCommandProvider";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import { PluginSlotMount } from "@/plugins/mount";
import { useSetPluginEnabled } from "@/components/plugin/useSetPluginEnabled";
import { appToast } from "@/components/ui/app-toast";
import { invalidatePluginList } from "@/hooks/queries/plugin-settings-queries";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { appQueryClient } from "@/lib/app-query-client";
import { usePluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import type { PluginSlot } from "@/plugins/registry";
import {
  getPluginPanelRoutePath,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import type { PaneContent } from "@/lib/split-layout";
import { openPaneContentInSplit } from "@/lib/split-layout/openPaneContentInSplit";

interface SidebarNavigationEntry {
  item: SidebarNavigationItem;
  content: PaneContent | null;
  route: string | null;
}

export interface SidebarNavigationModel {
  state: SidebarNavigationState;
  entries: readonly SidebarNavigationEntry[];
}

const SidebarNavigationModelContext =
  createContext<SidebarNavigationModel | null>(null);

export function SidebarNavigationIcon({
  icon,
  className,
}: SidebarNavigationIconProps) {
  if (icon.kind === "host") {
    return (
      <Icon
        name={icon.name === "search" ? "Search" : "MessageSquarePlus"}
        className={className}
        aria-hidden="true"
      />
    );
  }
  return (
    <PluginItemIcon
      pluginId={icon.pluginId}
      icon={icon.icon}
      className={className}
    />
  );
}

const wrappedAccessories = new WeakMap<ComponentType, ComponentType>();

function wrappedAccessory(
  panel: PluginSlot<"navPanels">,
): ComponentType | null {
  const Accessory = panel.sidebarAccessory;
  if (Accessory === undefined) return null;
  const cached = wrappedAccessories.get(Accessory);
  if (cached) return cached;
  const SidebarNavigationAccessory = () => (
    <PluginSlotMount
      key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
      pluginId={panel.pluginId}
      slotKind="navPanelSidebarAccessory"
      slotId={panel.id}
      crashFallback={<></>}
    >
      <Accessory />
    </PluginSlotMount>
  );
  wrappedAccessories.set(Accessory, SidebarNavigationAccessory);
  return SidebarNavigationAccessory;
}

function hostEntry(
  action: "new-thread" | "search-threads",
  label: string,
  shortcut: AppShortcutPresentation | null,
  isDisabled: boolean,
): SidebarNavigationEntry {
  const isNewThread = action === "new-thread";
  return {
    item: {
      id: `__bb__/${action}`,
      label,
      icon: { kind: "host", name: isNewThread ? "new-thread" : "search" },
      action: { kind: action },
      isDisabled,
      isVisible: isNewThread,
      isLoading: false,
      pluginId: null,
      shortcut: shortcut && {
        label: shortcut.label,
        ariaKeyShortcuts: shortcut.ariaKeyshortcuts,
      },
      Accessory: null,
    },
    content: isNewThread ? { kind: "new-thread" } : null,
    route: isNewThread ? getRootComposeRoutePath() : null,
  };
}

async function disablePlugin(
  item: SidebarNavigationItem,
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>,
): Promise<void> {
  try {
    await setPluginEnabled(item.pluginId ?? "", false);
    appToast.success(`${item.label} disabled`);
  } catch (error) {
    appToast.error(`Failed to disable ${item.label}`, {
      description: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await invalidatePluginList({ queryClient: appQueryClient });
  }
}

export function SidebarNavigationModelProvider({
  children,
}: {
  children: ReactNode;
}) {
  const panelEntries = usePluginNavPanelChrome();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const store = useStore();
  const commandRunner = useAppCommandRunner();
  const setPluginEnabled = useSetPluginEnabled();
  const newThreadShortcut = useAppCommandShortcut("thread.new");
  const threadSearchShortcut = useAppCommandShortcut("thread.search");
  const isShortcutModifierHeld = useIsAppCommandModifierHeld();
  const searchDisabled = !commandRunner.isCommandAvailable(
    "thread.search",
    null,
  );
  const entries: SidebarNavigationEntry[] = [
    hostEntry("new-thread", "New thread", newThreadShortcut, false),
    hostEntry(
      "search-threads",
      "Search threads",
      threadSearchShortcut,
      searchDisabled,
    ),
    ...panelEntries.map(({ chrome, panel }): SidebarNavigationEntry => ({
      item: {
        id: `${chrome.pluginId}/${chrome.id}`,
        label: chrome.title,
        icon: { kind: "plugin", pluginId: chrome.pluginId, icon: chrome.icon },
        action: {
          kind: "open-plugin-panel",
          pluginId: chrome.pluginId,
          panelId: chrome.id,
        },
        isDisabled: false,
        isVisible: true,
        isLoading: panel === null,
        pluginId: chrome.pluginId,
        shortcut: null,
        Accessory: panel === null ? null : wrappedAccessory(panel),
      },
      content: {
        kind: "plugin-panel",
        pluginId: chrome.pluginId,
        panelPath: chrome.path,
        subPath: "",
      },
      route: getPluginPanelRoutePath({
        pluginId: chrome.pluginId,
        path: chrome.path,
      }),
    })),
  ];
  const find = (itemId: string) =>
    entries.find((entry) => entry.item.id === itemId);
  const actions: SidebarNavigationActions = {
    activate(itemId, options) {
      const entry = find(itemId);
      if (!entry || entry.item.isDisabled || entry.item.isLoading) return;
      const { content, route } = entry;
      if (content === null || route === null) {
        commandRunner.dispatch("thread.search", null);
      } else if (options.openInSplit) {
        openPaneContentInSplit({
          store,
          navigate,
          content,
          route,
          enabled: true,
        });
      } else if (content.kind === "new-thread") {
        void navigate(route, { state: { focusPrompt: true } });
      } else {
        void navigate(route);
      }
    },
    async disablePlugin(itemId) {
      const item = find(itemId)?.item;
      if (item?.pluginId) await disablePlugin(item, setPluginEnabled);
    },
  };
  const activeItemId =
    entries.find(({ route, content }) =>
      content?.kind === "plugin-panel"
        ? pathname === route || pathname.startsWith(`${route}/`)
        : pathname === route,
    )?.item.id ?? null;
  const model: SidebarNavigationModel = {
    state: {
      items: entries.map((entry) => entry.item),
      activeItemId,
      isShortcutModifierHeld,
      actions,
    },
    entries,
  };
  return (
    <SidebarNavigationModelContext.Provider value={model}>
      {children}
    </SidebarNavigationModelContext.Provider>
  );
}

export function useSidebarNavigationModel(): SidebarNavigationModel | null {
  return useContext(SidebarNavigationModelContext);
}
