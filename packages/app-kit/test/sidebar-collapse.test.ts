import { describe, expect, it } from "vitest";
import {
  resolveDesktopCollapsedRailWidth,
  resolveSidebarCollapsible,
  resolveSidebarCollapsibleBodyWidth,
  shouldReserveCollapsedHeaderStart,
} from "../components/ui/sidebar-collapse";

describe("sidebar collapsed rail", () => {
  it("keeps the rail width only on wide windows", () => {
    expect(
      resolveDesktopCollapsedRailWidth({
        isCompactViewport: false,
        collapsedRailWidth: "52px",
      }),
    ).toBe("52px");
    expect(
      resolveDesktopCollapsedRailWidth({
        isCompactViewport: true,
        collapsedRailWidth: "52px",
      }),
    ).toBeNull();
    expect(
      resolveDesktopCollapsedRailWidth({
        isCompactViewport: false,
        collapsedRailWidth: undefined,
      }),
    ).toBeNull();
  });

  it("collapses to the rail when one is kept, offcanvas otherwise", () => {
    expect(
      resolveSidebarCollapsible({
        state: "collapsed",
        collapsedRailWidth: "52px",
      }),
    ).toBe("rail");
    expect(
      resolveSidebarCollapsible({
        state: "collapsed",
        collapsedRailWidth: null,
      }),
    ).toBe("offcanvas");
    expect(
      resolveSidebarCollapsible({
        state: "expanded",
        collapsedRailWidth: "52px",
      }),
    ).toBe("");
  });

  it("sizes the collapsible body to the sidebar minus the rail", () => {
    expect(
      resolveSidebarCollapsibleBodyWidth({
        width: "333px",
        collapsedRailWidth: "52px",
      }),
    ).toBe("calc(333px - 52px)");
    expect(
      resolveSidebarCollapsibleBodyWidth({
        width: "333px",
        collapsedRailWidth: null,
      }),
    ).toBe("100%");
  });

  it("reserves header space for the toggle only when nothing is left", () => {
    const base = {
      ownsWindowTopLeft: true,
      isCompactViewport: false,
      isSidebarShowing: false,
    };
    expect(
      shouldReserveCollapsedHeaderStart({
        ...base,
        sidebarKeepsCollapsedRail: true,
      }),
    ).toBe(false);
    expect(
      shouldReserveCollapsedHeaderStart({
        ...base,
        sidebarKeepsCollapsedRail: false,
      }),
    ).toBe(true);
    expect(
      shouldReserveCollapsedHeaderStart({
        ...base,
        isCompactViewport: true,
        sidebarKeepsCollapsedRail: false,
      }),
    ).toBe(true);
    expect(
      shouldReserveCollapsedHeaderStart({
        ...base,
        isSidebarShowing: true,
        sidebarKeepsCollapsedRail: true,
      }),
    ).toBe(false);
    expect(
      shouldReserveCollapsedHeaderStart({
        ...base,
        ownsWindowTopLeft: false,
        sidebarKeepsCollapsedRail: false,
      }),
    ).toBe(false);
  });
});
