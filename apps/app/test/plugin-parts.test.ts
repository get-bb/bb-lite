import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import {
  shell,
  type ComposerHandle,
  type PluginAppEntry,
} from "@bb/plugin/app";
import { useComposers } from "bb-plugin-composer/contract";
import * as composers from "../../../plugins/composer/app/lib/composers";
import { appParts, callPart, part } from "@bb/app-kit/plugins/parts";
import {
  registerPluginApp,
  resetPluginRegistryForTest,
  slotItems,
  unregisterPluginApp,
} from "@bb/app-kit/plugins/registry";

afterEach(() => resetPluginRegistryForTest());

function provide(
  id: string,
  parts: Record<string, unknown>,
  tier?: "installed",
  plugin = "greeter",
) {
  const app: PluginAppEntry = (bb) => {
    bb.add(appParts.parts, { plugin, parts });
  };
  expect(registerPluginApp(id, app, tier)).toBeNull();
}

it("resolves a part at use, so a replacement takes over without a new import", () => {
  const Greeting = part<(props: { name: string }) => null>(
    "greeter",
    "Greeting",
  );
  const shout = callPart<(text: string) => string>("greeter", "shout");
  const render = () =>
    renderToStaticMarkup(createElement(Greeting, { name: "Ada" }));
  expect(render()).toBe("");
  expect(() => shout("hi")).toThrow("Nothing provides greeter.shout");

  provide("greeter", {
    Greeting: ({ name }: { name: string }) => `hello ${name}`,
    shout: (text: string) => text.toUpperCase(),
  });
  expect(render()).toBe("hello Ada");
  expect(shout("hi")).toBe("HI");

  unregisterPluginApp("greeter");
  provide(
    "greeter",
    {
      Greeting: ({ name }: { name: string }) => `good day ${name}`,
      shout: (text: string) => `${text}!`,
    },
    "installed",
  );
  expect(render()).toBe("good day Ada");
  expect(shout("hi")).toBe("hi!");
});

it("adds shell extras and row statuses as slot entries that leave with the plugin", () => {
  const ran: string[] = [];
  const app: PluginAppEntry = (bb) => {
    bb.add(shell.sidebarFooter, {
      id: "docs",
      label: "Docs",
      icon: "Book",
      run: () => void ran.push("docs"),
    });
    const running = { icon: "Loader", label: "Building" };
    bb.add(shell.threadRowStatus, { threadId: "thr_1", ...running });
  };
  expect(registerPluginApp("extras", app, "installed")).toBeNull();
  slotItems(shell.sidebarFooter)[0]?.run?.();
  expect(ran).toEqual(["docs"]);
  const statuses = slotItems(shell.threadRowStatus);
  expect(statuses).toMatchObject([{ threadId: "thr_1", label: "Building" }]);
  unregisterPluginApp("extras");
  expect(slotItems(shell.threadRowStatus)).toEqual([]);
  expect(slotItems(shell.sidebarFooter)).toEqual([]);
});

it("gets the composers on screen from whichever plugin is the composer", () => {
  function Keys() {
    return useComposers()
      .map(({ key }) => key)
      .join(",");
  }
  const render = () => renderToStaticMarkup(createElement(Keys));
  expect(render).toThrow("Nothing provides composer.useComposers");

  const { useComposer, useComposers: listed, showComposer } = composers;
  provide(
    "composer",
    { useComposer, useComposers: listed },
    undefined,
    "composer",
  );
  const handle = { key: "follow-up:thr_1" } as ComposerHandle;
  const hide = showComposer(handle);
  expect(render()).toBe("follow-up:thr_1");
  hide();
  expect(render()).toBe("");

  const forked = () => [{ key: "from-a-fork" }];
  provide("my-composer", { useComposers: forked }, "installed", "composer");
  expect(render()).toBe("from-a-fork");
});
