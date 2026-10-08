import { Suspense, useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import { shell, type ShellRoute, type SlotEntryView } from "@bb/plugin/app";
import { SlotMount, useSlotEntries } from "@bb/app-kit/plugins/slots";
import { AppLayout } from "./components/layout/AppLayout";

const CORE_PLUGIN_IDS: readonly string[] = [
  "shell",
  "thread-view",
  "composer",
  "side-panel",
  "settings",
];
const UNORDERED = 1_000;

type RouteEntry = SlotEntryView<ShellRoute>;

function ordered(entries: readonly RouteEntry[]): RouteEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Number(a.entry.item.path === "*") - Number(b.entry.item.path === "*") ||
        (a.entry.item.order ?? UNORDERED) - (b.entry.item.order ?? UNORDERED) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

function ShellRouteElement({ plugin, item }: RouteEntry) {
  const View = item.view;
  if (CORE_PLUGIN_IDS.includes(plugin)) return <View />;
  return (
    <SlotMount pluginId={plugin} slot={shell.route.name} id={item.id}>
      <View />
    </SlotMount>
  );
}

export function ShellRoot() {
  const entries = useSlotEntries(shell.route);
  const routes = useMemo(() => ordered(entries), [entries]);
  return (
    <AppLayout>
      <Suspense fallback={null}>
        <Routes>
          {routes.map((entry) => (
            <Route
              key={entry.item.id}
              path={entry.item.path}
              element={<ShellRouteElement {...entry} />}
            />
          ))}
        </Routes>
      </Suspense>
    </AppLayout>
  );
}
