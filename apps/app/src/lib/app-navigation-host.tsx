import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { JsonValue } from "@bb/plugin/app";

interface AppUrlOpenIntent {
  url: string;
}

export interface AppFixedTabReference {
  ownerId: string;
  tabId: string;
}

export interface AppFixedTabOpenIntent {
  surface: { kind: "current" };
  tab: AppFixedTabReference;
  target?: JsonValue;
}

interface AppNavigationHostCapabilities {
  openFixedTab?: (intent: AppFixedTabOpenIntent) => boolean;
  openUrl?: (intent: AppUrlOpenIntent) => boolean;
}

interface ResolvedAppNavigationHostCapabilities {
  openFixedTab: (intent: AppFixedTabOpenIntent) => boolean;
  openUrl: (intent: AppUrlOpenIntent) => boolean;
}

const rejectNavigationIntent = () => false;
const DEFAULT_APP_NAVIGATION_HOST: ResolvedAppNavigationHostCapabilities = {
  openFixedTab: rejectNavigationIntent,
  openUrl: rejectNavigationIntent,
};

const AppNavigationHostContext =
  createContext<ResolvedAppNavigationHostCapabilities>(
    DEFAULT_APP_NAVIGATION_HOST,
  );

export function AppNavigationHostProvider({
  capabilities,
  children,
}: {
  capabilities: AppNavigationHostCapabilities;
  children: ReactNode;
}) {
  const parent = useContext(AppNavigationHostContext);
  const value = useMemo<ResolvedAppNavigationHostCapabilities>(
    () => ({
      openFixedTab: capabilities.openFixedTab ?? parent.openFixedTab,
      openUrl: capabilities.openUrl ?? parent.openUrl,
    }),
    [
      capabilities.openFixedTab,
      capabilities.openUrl,
      parent.openFixedTab,
      parent.openUrl,
    ],
  );
  return (
    <AppNavigationHostContext.Provider value={value}>
      {children}
    </AppNavigationHostContext.Provider>
  );
}

export function useAppNavigationHost() {
  return useContext(AppNavigationHostContext);
}
