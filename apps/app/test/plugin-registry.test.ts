import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePluginApp, type PluginAppApi } from "@bb/plugin/app";
import {
  AUTOMATIC_PROVIDER,
  NO_PROVIDER,
  collectPluginApp,
  getPluginSlots,
  isSlotCrashed,
  markSlotCrashed,
  providerKey,
  registerPluginApp,
  resetCrashedSlots,
  resetPluginRegistryForTest,
  resolveMessageDirectives,
  resolveProvider,
  slotInstanceKey,
  unregisterPluginApp,
} from "../src/plugins/registry";

const Component = () => null;

function registerEverySlot(app: PluginAppApi): void {
  app.slots.navPanel({
    id: "panel",
    title: "Panel",
    icon: "ListTodo",
    path: "panel",
    component: Component,
  });
  app.slots.threadPanel({ id: "side", title: "Side", component: Component });
  app.slots.settingsSection({ id: "settings", component: Component });
  app.slots.appOverlay({ id: "overlay", component: Component });
  app.slots.pendingInteraction({ id: "form", component: Component });
  app.slots.messageDirective({ id: "card", component: Component });
  app.slots.threadList({ id: "list", title: "List", component: Component });
  app.slots.sidebarNavigation({
    id: "nav",
    title: "Nav",
    component: Component,
  });
  app.slots.sidebarHeader({ id: "head", title: "Head", component: Component });
  app.commands.register({ id: "run", title: "Run", run: () => {} });
}

function threadList(pluginId: string, id: string) {
  return definePluginApp((app) => {
    app.slots.threadList({
      id,
      title: `${pluginId} list`,
      component: Component,
    });
  });
}

describe("plugin registry", () => {
  beforeEach(() => {
    resetPluginRegistryForTest();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects one registration for every slot kind", () => {
    const collected = collectPluginApp(definePluginApp(registerEverySlot));
    expect(
      Object.fromEntries(
        Object.entries<readonly { id: string }[]>({ ...collected }).map(
          ([kind, list]) => [kind, list.map((registration) => registration.id)],
        ),
      ),
    ).toEqual({
      navPanels: ["panel"],
      threadPanels: ["side"],
      settingsSections: ["settings"],
      appOverlays: ["overlay"],
      pendingInteractions: ["form"],
      messageDirectives: ["card"],
      threadLists: ["list"],
      sidebarNavigations: ["nav"],
      sidebarHeaders: ["head"],
      commands: ["run"],
    });
  });

  it("stamps registrations with their plugin and publishes them", () => {
    expect(
      registerPluginApp("demo", definePluginApp(registerEverySlot)),
    ).toBeNull();
    const slots = getPluginSlots();
    expect(slots.navPanels).toMatchObject([
      { id: "panel", pluginId: "demo", generation: 1 },
    ]);
    expect(slots.commands).toMatchObject([{ id: "run", pluginId: "demo" }]);
    registerPluginApp("demo", definePluginApp(registerEverySlot));
    expect(getPluginSlots().navPanels[0]?.generation).toBe(2);
    unregisterPluginApp("demo");
    expect(getPluginSlots().navPanels).toEqual([]);
  });

  it("keeps a slot list's identity when another kind changes", () => {
    registerPluginApp("a", threadList("a", "list"));
    const before = getPluginSlots().threadLists;
    registerPluginApp(
      "b",
      definePluginApp((app) => {
        app.slots.appOverlay({ id: "overlay", component: Component });
      }),
    );
    expect(getPluginSlots().threadLists).toBe(before);
    expect(getPluginSlots().appOverlays).toHaveLength(1);
  });

  it("rejects duplicate, malformed and component-less registrations", () => {
    expect(() =>
      collectPluginApp(
        definePluginApp((app) => {
          app.slots.appOverlay({ id: "same", component: Component });
          app.slots.appOverlay({ id: "same", component: Component });
        }),
      ),
    ).toThrow(/duplicate id "same"/);
    expect(() =>
      collectPluginApp(
        definePluginApp((app) => {
          app.slots.appOverlay({ id: "has space", component: Component });
        }),
      ),
    ).toThrow(/"id" must match/);
    expect(() =>
      collectPluginApp(
        definePluginApp((app) => {
          app.slots.appOverlay({ id: "empty" } as never);
        }),
      ),
    ).toThrow(/missing component/);
    expect(() =>
      collectPluginApp(
        definePluginApp((app) => {
          app.commands.register({ id: "idle", title: "Idle" } as never);
        }),
      ),
    ).toThrow(/missing run/);
  });

  it("allows the same id in different slot kinds and plugins", () => {
    const shared = definePluginApp((app) => {
      app.slots.sidebarNavigation({
        id: "icons",
        title: "Icons",
        component: Component,
      });
      app.slots.sidebarHeader({
        id: "icons",
        title: "Icons",
        component: Component,
      });
    });
    expect(registerPluginApp("one", shared)).toBeNull();
    expect(registerPluginApp("two", shared)).toBeNull();
    expect(getPluginSlots().sidebarHeaders.map(providerKey)).toEqual([
      "one/icons",
      "two/icons",
    ]);
  });

  it("drops only the plugin whose setup throws", () => {
    registerPluginApp("good", threadList("good", "list"));
    registerPluginApp("flaky", threadList("flaky", "list"));
    const error = registerPluginApp(
      "flaky",
      definePluginApp((app) => {
        app.slots.appOverlay({ id: "overlay", component: Component });
        throw new Error("boom");
      }),
    );
    expect(error?.message).toBe("boom");
    const slots = getPluginSlots();
    expect(slots.threadLists.map(providerKey)).toEqual(["good/list"]);
    expect(slots.appOverlays).toEqual([]);
    expect(registerPluginApp("later", threadList("later", "list"))).toBeNull();
    expect(getPluginSlots().threadLists.map(providerKey)).toEqual([
      "good/list",
      "later/list",
    ]);
  });

  describe("exclusive providers", () => {
    const bundled = "thread-list/thread-list";
    function lists() {
      return getPluginSlots().threadLists;
    }
    function resolvedKey(preference: string, settled = true) {
      const resolved = resolveProvider(lists(), preference, {
        bundled,
        settled,
      });
      return resolved.kind === "plugin"
        ? providerKey(resolved.slot)
        : resolved.kind;
    }

    it("follows an explicit preference", () => {
      registerPluginApp(
        "thread-list",
        threadList("thread-list", "thread-list"),
      );
      registerPluginApp("cursor", threadList("cursor", "sidebar"));
      expect(resolvedKey("cursor/sidebar")).toBe("cursor/sidebar");
      expect(resolvedKey(bundled)).toBe(bundled);
    });

    it("prefers a non-bundled provider when automatic", () => {
      registerPluginApp(
        "thread-list",
        threadList("thread-list", "thread-list"),
      );
      expect(resolvedKey(AUTOMATIC_PROVIDER)).toBe(bundled);
      registerPluginApp("cursor", threadList("cursor", "sidebar"));
      expect(resolvedKey(AUTOMATIC_PROVIDER)).toBe("cursor/sidebar");
    });

    it("waits for a missing provider, then falls back to the bundled one", () => {
      registerPluginApp(
        "thread-list",
        threadList("thread-list", "thread-list"),
      );
      expect(resolvedKey("gone/list", false)).toBe("loading");
      expect(resolvedKey("gone/list", true)).toBe(bundled);
    });

    it("reports missing when nothing can render the slot", () => {
      expect(resolvedKey(AUTOMATIC_PROVIDER, false)).toBe("loading");
      expect(resolvedKey(AUTOMATIC_PROVIDER, true)).toBe("missing");
      expect(resolvedKey("gone/list", true)).toBe("missing");
      expect(
        resolveProvider(lists(), "gone/list", { settled: true }).kind,
      ).toBe("missing");
    });

    it("renders nothing for the explicit no-provider choice", () => {
      registerPluginApp(
        "thread-list",
        threadList("thread-list", "thread-list"),
      );
      expect(resolvedKey(NO_PROVIDER)).toBe("none");
    });

    it("keeps a crashed provider selected until it is reloaded", () => {
      registerPluginApp(
        "thread-list",
        threadList("thread-list", "thread-list"),
      );
      registerPluginApp("cursor", threadList("cursor", "sidebar"));
      const key = slotInstanceKey("cursor", "threadList", "sidebar");
      markSlotCrashed(key);
      expect(isSlotCrashed(key)).toBe(true);
      expect(resolvedKey("cursor/sidebar")).toBe("cursor/sidebar");
      resetCrashedSlots("cursor");
      expect(isSlotCrashed(key)).toBe(false);
      markSlotCrashed(key);
      registerPluginApp("cursor", threadList("cursor", "sidebar"));
      expect(isSlotCrashed(key)).toBe(false);
    });
  });

  it("flags a message directive claimed by two plugins", () => {
    const card = definePluginApp((app) => {
      app.slots.messageDirective({ id: "card", component: Component });
    });
    registerPluginApp("b", card);
    registerPluginApp("a", card);
    registerPluginApp(
      "c",
      definePluginApp((app) => {
        app.slots.messageDirective({ id: "solo", component: Component });
      }),
    );
    const resolved = resolveMessageDirectives(
      getPluginSlots().messageDirectives,
    );
    expect(resolved.get("card")).toEqual({
      status: "collision",
      pluginIds: ["a", "b"],
    });
    expect(resolved.get("solo")).toMatchObject({
      status: "ok",
      slot: { pluginId: "c" },
    });
  });
});
