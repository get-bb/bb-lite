import { useMemo, useSyncExternalStore } from "react";
import type { Slot, SlotEntryView, SlotMountProps } from "@bb/plugin/app";
import { PluginSlotMount } from "./mount";
import {
  ownedItems,
  slotEntries,
  slotItems,
  watchSlots,
  type Owned,
} from "./registry";

export function useSlot<Item>(slot: Slot<Item>): readonly Item[] {
  return useSyncExternalStore(watchSlots, () => slotItems(slot));
}

export function useSlotEntries<Item>(
  slot: Slot<Item>,
): readonly SlotEntryView<Item>[] {
  return useSyncExternalStore(watchSlots, () => slotEntries(slot));
}

export function useSlotEntry<Item>(slot: Slot<Item>, key: string): Item | null {
  const items = useSlot(slot);
  const field = slot.key;
  return useMemo(() => {
    if (field === null) return null;
    const matching = items.filter(
      (item) => (item as Record<string, unknown>)[field] === key,
    );
    return matching.at(-1) ?? null;
  }, [items, field, key]);
}

export function useOwned<Item extends object>(
  slot: Slot<Item>,
): readonly Owned<Item>[] {
  return useSyncExternalStore(watchSlots, () => ownedItems(slot));
}

export function useSlotOwner<Item>(slot: Slot<Item>, item: Item): string {
  const entries = useSlotEntries(slot);
  return entries.find((entry) => entry.item === item)?.plugin ?? "bb";
}

export function SlotMount({
  pluginId,
  slot,
  id,
  children,
  fallback,
}: SlotMountProps) {
  return (
    <PluginSlotMount
      pluginId={pluginId}
      slotKind={slot}
      slotId={id}
      crashFallback={fallback}
    >
      {children}
    </PluginSlotMount>
  );
}
