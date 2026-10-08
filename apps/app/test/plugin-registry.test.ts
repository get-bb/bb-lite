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
  resetPluginRegistryForTest,
  resolveMessageDirectives,
  resolveProvider,
  slotInstanceKey,
  unregisterPluginApp,
} from "@bb/app-kit/plugins/registry";

const component = () => null;
const bundled = "thread-list/thread-list";

function registerEverySlot(app: PluginAppApi): void {
  const titled = { title: "Title", component };
  app.slots.navPanel({ id: "panel", icon: "ListTodo", path: "p", ...titled });
  app.slots.threadPanel({ id: "side", ...titled });
  app.slots.settingsSection({ id: "settings", component });
  app.slots.appOverlay({ id: "overlay", component });
  app.slots.pendingInteraction({ id: "form", component });
  app.slots.messageDirective({ id: "card", component });
  app.slots.threadList({ id: "list", ...titled });
  app.slots.sidebarNavigation({ id: "nav", ...titled });
  app.slots.sidebarHeader({ id: "head", ...titled });
  app.commands.register({ id: "run", title: "Run", run: () => {} });
}

function threadList(pluginId: string, id: string) {
  return definePluginApp((app) => {
    app.slots.threadList({ id, title: `${pluginId} list`, component });
  });
}

function overlays(...registrations: object[]) {
  return definePluginApp((app) => {
    for (const registration of registrations) {
      app.slots.appOverlay(registration as never);
    }
  });
}

function resolvedKey(preference: string, settled = true) {
  const lists = getPluginSlots().threadLists;
  const resolved = resolveProvider(lists, preference, { bundled, settled });
  return resolved.kind === "plugin"
    ? providerKey(resolved.slot)
    : resolved.kind;
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

  it("stamps, republishes and removes a plugin's registrations", () => {
    const everything = definePluginApp(registerEverySlot);
    expect(registerPluginApp("demo", everything)).toBeNull();
    expect(getPluginSlots().navPanels).toMatchObject([
      { id: "panel", pluginId: "demo", generation: 1 },
    ]);
    const lists = getPluginSlots().threadLists;
    registerPluginApp("other", overlays({ id: "overlay", component }));
    expect(getPluginSlots().threadLists).toBe(lists);
    expect(getPluginSlots().appOverlays.map(providerKey)).toEqual([
      "demo/overlay",
      "other/overlay",
    ]);
    registerPluginApp("demo", everything);
    expect(getPluginSlots().navPanels[0]?.generation).toBe(2);
    unregisterPluginApp("demo");
    expect(getPluginSlots().navPanels).toEqual([]);
  });

  it("rejects duplicate, malformed and component-less registrations", () => {
    const same = { id: "same", component };
    expect(() => collectPluginApp(overlays(same, same))).toThrow(
      /duplicate id "same"/,
    );
    expect(() =>
      collectPluginApp(overlays({ id: "has space", component })),
    ).toThrow(/"id" must match/);
    expect(() => collectPluginApp(overlays({ id: "empty" }))).toThrow(
      /missing component/,
    );
    expect(() =>
      collectPluginApp(
        definePluginApp((app) => {
          app.commands.register({ id: "idle", title: "Idle" } as never);
        }),
      ),
    ).toThrow(/missing run/);
  });

  it("drops only the plugin whose setup throws", () => {
    registerPluginApp("good", threadList("good", "list"));
    registerPluginApp("flaky", threadList("flaky", "list"));
    const error = registerPluginApp(
      "flaky",
      definePluginApp((app) => {
        app.slots.appOverlay({ id: "overlay", component });
        throw new Error("boom");
      }),
    );
    expect(error?.message).toBe("boom");
    expect(getPluginSlots().threadLists.map(providerKey)).toEqual([
      "good/list",
    ]);
    expect(getPluginSlots().appOverlays).toEqual([]);
  });

  it("resolves an exclusive provider from the preference", () => {
    expect(resolvedKey(AUTOMATIC_PROVIDER, false)).toBe("loading");
    expect(resolvedKey(AUTOMATIC_PROVIDER)).toBe("missing");
    registerPluginApp("thread-list", threadList("thread-list", "thread-list"));
    expect(resolvedKey(AUTOMATIC_PROVIDER)).toBe(bundled);
    expect(resolvedKey("gone/list", false)).toBe("loading");
    expect(resolvedKey("gone/list")).toBe(bundled);
    expect(resolvedKey(NO_PROVIDER)).toBe("none");
    registerPluginApp("cursor", threadList("cursor", "sidebar"));
    expect(resolvedKey(AUTOMATIC_PROVIDER)).toBe("cursor/sidebar");
    expect(resolvedKey("cursor/sidebar")).toBe("cursor/sidebar");
    expect(resolvedKey(bundled)).toBe(bundled);
  });

  it("forgets a crashed slot when its plugin registers again", () => {
    registerPluginApp("cursor", threadList("cursor", "sidebar"));
    const key = slotInstanceKey("cursor", "threadList", "sidebar");
    markSlotCrashed(key);
    expect(isSlotCrashed(key)).toBe(true);
    expect(resolvedKey("cursor/sidebar")).toBe("cursor/sidebar");
    registerPluginApp("cursor", threadList("cursor", "sidebar"));
    expect(isSlotCrashed(key)).toBe(false);
  });

  it("flags a message directive claimed by two plugins", () => {
    const directive = (id: string) =>
      definePluginApp((app) => {
        app.slots.messageDirective({ id, component });
      });
    registerPluginApp("b", directive("card"));
    registerPluginApp("a", directive("card"));
    registerPluginApp("c", directive("solo"));
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
