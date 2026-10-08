import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { definePluginApp, shell, type ComposerHandle } from "@bb/plugin/app";
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
  const app = definePluginApp((bb) => {
    bb.add(appParts.parts, { plugin, parts });
  });
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

it("registers mount scripts and shell extras through the same slots", () => {
  const ran: string[] = [];
  const app = definePluginApp((bb) => {
    bb.onMount(() => {
      ran.push("mounted");
      return () => void ran.push("unmounted");
    });
    bb.add(shell.sidebarFooter, {
      id: "docs",
      label: "Docs",
      icon: "Book",
      run: () => void ran.push("docs"),
    });
  });
  expect(registerPluginApp("extras", app, "installed")).toBeNull();
  const [mount] = slotItems(shell.mount);
  const stop = mount?.run({ signal: new AbortController().signal });
  slotItems(shell.sidebarFooter)[0]?.run?.();
  if (typeof stop === "function") stop();
  expect(ran).toEqual(["mounted", "docs", "unmounted"]);
  unregisterPluginApp("extras");
  expect(slotItems(shell.mount)).toEqual([]);
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
