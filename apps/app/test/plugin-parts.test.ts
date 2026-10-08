import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { definePluginApp } from "@bb/plugin/app";
import { appParts, callPart, part } from "@bb/app-kit/plugins/parts";
import {
  registerPluginApp,
  resetPluginRegistryForTest,
  unregisterPluginApp,
} from "@bb/app-kit/plugins/registry";

afterEach(() => resetPluginRegistryForTest());

function provide(
  id: string,
  parts: Record<string, unknown>,
  tier?: "installed",
) {
  const app = definePluginApp((bb) => {
    bb.add(appParts.parts, { plugin: "greeter", parts });
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
