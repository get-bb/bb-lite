import { createElement, useSyncExternalStore, type ComponentType } from "react";
import { app } from "@bb/plugin/app";
import { slotItems, watchSlots } from "./registry";

function partOf(plugin: string, name: string): unknown {
  const bags = slotItems(app.parts);
  return bags.filter((bag) => bag.plugin === plugin).at(-1)?.parts[name];
}

export function part<View>(plugin: string, name: string): View {
  function Part(props: object) {
    const find = () => partOf(plugin, name);
    const found = useSyncExternalStore(watchSlots, find, find);
    if (found === undefined) return null;
    return createElement(found as ComponentType<object>, props);
  }
  Part.displayName = `${plugin}.${name}`;
  return Part as View;
}

export function callPart<Run>(plugin: string, name: string): Run {
  const run = (...inputs: unknown[]): unknown => {
    const found = partOf(plugin, name);
    if (typeof found !== "function") {
      throw new Error(`Nothing provides ${plugin}.${name}`);
    }
    return (found as (...inputs: unknown[]) => unknown)(...inputs);
  };
  return run as Run;
}
