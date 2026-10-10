export type SidebarCollapsible = "" | "offcanvas" | "rail";

export function resolveDesktopCollapsedRailWidth({
  isCompactViewport,
  collapsedRailWidth,
}: {
  isCompactViewport: boolean;
  collapsedRailWidth: string | undefined;
}): string | null {
  return isCompactViewport ? null : (collapsedRailWidth ?? null);
}

export function resolveSidebarCollapsible({
  state,
  collapsedRailWidth,
}: {
  state: "expanded" | "collapsed";
  collapsedRailWidth: string | null;
}): SidebarCollapsible {
  if (state === "expanded") return "";
  return collapsedRailWidth === null ? "offcanvas" : "rail";
}

export function resolveSidebarCollapsibleBodyWidth({
  width,
  collapsedRailWidth,
}: {
  width: string;
  collapsedRailWidth: string | null;
}): string {
  return collapsedRailWidth === null
    ? "100%"
    : `calc(${width} - ${collapsedRailWidth})`;
}

export function shouldReserveCollapsedHeaderStart({
  ownsWindowTopLeft,
  isCompactViewport,
  isSidebarShowing,
  sidebarKeepsCollapsedRail,
}: {
  ownsWindowTopLeft: boolean;
  isCompactViewport: boolean;
  isSidebarShowing: boolean;
  sidebarKeepsCollapsedRail: boolean;
}): boolean {
  if (!ownsWindowTopLeft) return false;
  if (isCompactViewport) return true;
  return !isSidebarShowing && !sidebarKeepsCollapsedRail;
}
