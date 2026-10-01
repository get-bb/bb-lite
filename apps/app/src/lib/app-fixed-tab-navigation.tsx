import type { JsonValue } from "@bb/plugin/app";

export interface AppFixedTabReference {
  ownerId: string;
  tabId: string;
}

export interface AppFixedTabOpenIntent {
  surface: { kind: "current" };
  tab: AppFixedTabReference;
  target?: JsonValue;
}

export interface AppFixedTabDestination {
  open(target: JsonValue | undefined): boolean;
  tab: AppFixedTabReference;
}

export function openAppFixedTabFromDestinations(
  destinations: readonly AppFixedTabDestination[],
  intent: AppFixedTabOpenIntent,
): boolean {
  const destination = destinations.find(
    (candidate) =>
      candidate.tab.ownerId === intent.tab.ownerId &&
      candidate.tab.tabId === intent.tab.tabId,
  );
  return destination?.open(intent.target) ?? false;
}
