import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  settings,
  shell,
  sidePanel,
  threadView,
  type PluginAppApi,
  type PluginAppEntry,
  type ShellOverlay,
} from "@bb/plugin/app";
import {
  AUTOMATIC_PROVIDER,
  NO_PROVIDER,
  isSlotCrashed,
  markPluginsSettled,
  markSlotCrashed,
  ownedItems,
  providerKey,
  registerPluginApp,
  resetPluginRegistryForTest,
  resolveMessageDirectives,
  resolveProvider,
  slotInstanceKey,
  slotItems,
  unregisterPluginApp,
} from "@bb/app-kit/plugins/registry";

const view = () => null;
const bundled = "thread-list/thread-list";

function registerEverySlot(bb: PluginAppApi): void {
  const titled = { title: "Title", view };
  bb.add(shell.navPanel, {
    id: "panel",
    icon: "ListTodo",
    path: "p",
    ...titled,
  });
  bb.add(sidePanel.panel, { id: "side", ...titled });
  bb.add(settings.section, { id: "settings", view });
  bb.add(shell.overlay, { id: "overlay", view });
  bb.add(threadView.interaction, { id: "form", view });
  bb.add(threadView.messageDirective, { id: "card", view });
  bb.add(shell.threadList, { id: "list", ...titled });
  bb.add(shell.sidebarNavigation, { id: "nav", ...titled });
  bb.add(shell.sidebarHeader, { id: "head", ...titled });
  bb.add(shell.command, { id: "run", title: "Run", run: () => {} });
}

function threadList(pluginId: string, id: string): PluginAppEntry {
  return (bb) => {
    bb.add(shell.threadList, { id, title: `${pluginId} list`, view });
  };
}

function overlays(...registrations: object[]): PluginAppEntry {
  return (bb) => {
    for (const registration of registrations) {
      bb.add(shell.overlay, registration as ShellOverlay);
    }
  };
}

function resolvedKey(preference: string, settled = true) {
  const lists = ownedItems(shell.threadList);
  const resolved = resolveProvider(lists, preference, { bundled, settled });
  return resolved.kind === "plugin"
    ? providerKey(resolved.slot)
    : resolved.kind;
}

function refusal(entry: PluginAppEntry): string | undefined {
  return registerPluginApp("checked", entry)?.message;
}

describe("plugin registry", () => {
  beforeEach(() => {
    resetPluginRegistryForTest();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows one entry for every slot a plugin fills, with its owner", () => {
    expect(registerPluginApp("demo", registerEverySlot)).toBeNull();
    const ids = (items: readonly { id: string }[]) => items.map(({ id }) => id);
    expect({
      navPanel: ids(slotItems(shell.navPanel)),
      panel: ids(slotItems(sidePanel.panel)),
      section: ids(slotItems(settings.section)),
      overlay: ids(slotItems(shell.overlay)),
      interaction: ids(slotItems(threadView.interaction)),
      messageDirective: ids(slotItems(threadView.messageDirective)),
      threadList: ids(slotItems(shell.threadList)),
      sidebarNavigation: ids(slotItems(shell.sidebarNavigation)),
      sidebarHeader: ids(slotItems(shell.sidebarHeader)),
      command: ids(slotItems(shell.command)),
    }).toEqual({
      navPanel: ["panel"],
      panel: ["side"],
      section: ["settings"],
      overlay: ["overlay"],
      interaction: ["form"],
      messageDirective: ["card"],
      threadList: ["list"],
      sidebarNavigation: ["nav"],
      sidebarHeader: ["head"],
      command: ["run"],
    });
    const owned = { id: "panel", pluginId: "demo" };
    expect(ownedItems(shell.navPanel)).toMatchObject([owned]);
  });

  it("keeps a slot's list stable until it changes, and empties it on unload", () => {
    registerPluginApp("demo", registerEverySlot);
    const lists = ownedItems(shell.threadList);
    registerPluginApp("other", overlays({ id: "overlay", view }));
    expect(ownedItems(shell.threadList)).toBe(lists);
    expect(ownedItems(shell.overlay).map(providerKey)).toEqual([
      "demo/overlay",
      "other/overlay",
    ]);
    unregisterPluginApp("demo");
    expect(slotItems(shell.navPanel)).toEqual([]);
  });

  it("rejects duplicate, malformed and view-less entries", () => {
    const same = { id: "same", view };
    expect(refusal(overlays(same, same))).toMatch(/duplicate id "same"/u);
    const spaced = overlays({ id: "has space", view });
    expect(refusal(spaced)).toMatch(/"id" must match/u);
    expect(refusal(overlays({ id: "empty" }))).toMatch(/missing view/u);
    const idle = { id: "idle", title: "Idle" };
    const command: PluginAppEntry = (bb) => {
      bb.add(shell.command, idle as never);
    };
    expect(refusal(command)).toMatch(/missing run/u);
    expect(slotItems(shell.overlay)).toEqual([]);
  });

  it("drops only the plugin whose setup throws", () => {
    registerPluginApp("good", threadList("good", "list"));
    registerPluginApp("flaky", threadList("flaky", "list"));
    const error = registerPluginApp("flaky", (bb) => {
      bb.add(shell.overlay, { id: "overlay", view });
      throw new Error("boom");
    });
    expect(error?.message).toBe("boom");
    expect(ownedItems(shell.threadList).map(providerKey)).toEqual([
      "good/list",
    ]);
    expect(slotItems(shell.overlay)).toEqual([]);
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
    const directive =
      (id: string): PluginAppEntry =>
      (bb) => {
        bb.add(threadView.messageDirective, { id, view });
      };
    registerPluginApp("b", directive("card"));
    registerPluginApp("a", directive("card"));
    registerPluginApp("c", directive("solo"));
    const resolved = resolveMessageDirectives(
      ownedItems(threadView.messageDirective),
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

  it("runs onStart once plugins have settled and its cleanup on unload", async () => {
    const ran: string[] = [];
    const entry: PluginAppEntry = (bb) => {
      bb.onStart(() => {
        ran.push("started");
        return () => void ran.push("stopped");
      });
      bb.onDispose(() => void ran.push("disposed"));
    };
    registerPluginApp("early", entry);
    await Promise.resolve();
    expect(ran).toEqual([]);
    markPluginsSettled();
    await vi.waitFor(() => expect(ran).toEqual(["started"]));
    unregisterPluginApp("early");
    await vi.waitFor(() =>
      expect(ran).toEqual(["started", "stopped", "disposed"]),
    );
    registerPluginApp("late", entry);
    await vi.waitFor(() => expect(ran.at(-1)).toBe("started"));
  });
});
