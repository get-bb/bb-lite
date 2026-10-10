// @vitest-environment jsdom
import { act, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { app, composer, type ComposerHandle } from "@bb/plugin/app";
import { callPart } from "@bb/app-kit/plugins/parts";
import {
  hookImplementationsVersion,
  registerPluginApp,
  resetPluginRegistryForTest,
  useHookImplementationsVersion,
} from "@bb/app-kit/plugins/registry";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => resetPluginRegistryForTest());

function provide(
  id: string,
  parts: Record<string, unknown>,
  tier?: "installed",
  plugin = "side-panel",
) {
  const added = registerPluginApp(
    id,
    (bb) => void bb.add(app.parts, { plugin, parts }),
    tier,
  );
  expect(added).toBeNull();
}

function useCorePanel(): string {
  const [label] = useState("core panel");
  return label;
}

function useForkedPanel(): string {
  const seen = useRef(0);
  seen.current += 1;
  return useMemo(() => "forked panel", []);
}

const usePanel = callPart<() => string>("side-panel", "usePanel");

function ThreadDetail() {
  const [title] = useState("thread");
  return `${title}: ${usePanel()}`;
}

function Shell() {
  return <ThreadDetail key={useHookImplementationsVersion()} />;
}

it("remounts what calls a hook part when a fork swaps its implementation", async () => {
  provide("side-panel", { usePanel: useCorePanel, Header: () => null });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  expect(container.textContent).toBe("thread: core panel");

  const before = hookImplementationsVersion();
  await act(async () =>
    provide("my-side-panel", { usePanel: useForkedPanel }, "installed"),
  );
  expect(hookImplementationsVersion()).toBe(before + 1);
  expect(container.textContent).toBe("thread: forked panel");
  await act(async () => root.unmount());
});

it("leaves the version alone when no hook in use changes", () => {
  provide("side-panel", { usePanel: useCorePanel, Header: () => null });
  const before = hookImplementationsVersion();
  provide("other", { useOther: useCorePanel }, "installed", "other");
  provide(
    "my-header",
    { usePanel: useCorePanel, Header: () => "x" },
    "installed",
  );
  expect(hookImplementationsVersion()).toBe(before);
  provide("my-side-panel", { Header: () => "y" }, "installed");
  expect(hookImplementationsVersion()).toBe(before + 1);
});

it("counts a forked composer api as a swap of its hooks", () => {
  const none = (): ComposerHandle | null => null;
  const listed = (): readonly ComposerHandle[] => [];
  registerPluginApp("composer", (bb) => {
    bb.add(composer.api, {
      useComposer: none,
      useComposers: listed,
      active: () => null,
    });
  });
  const before = hookImplementationsVersion();
  registerPluginApp(
    "my-composer",
    (bb) => {
      bb.add(composer.api, {
        useComposer: () => none(),
        useComposers: listed,
        active: () => null,
      });
    },
    "installed",
  );
  expect(hookImplementationsVersion()).toBe(before + 1);
});
