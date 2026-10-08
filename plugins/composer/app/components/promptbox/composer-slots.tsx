import { useMemo, type ComponentProps, type ReactNode } from "react";
import {
  composer,
  type ComposerContext,
  type ComposerFooterControl,
  type ComposerHandle,
  type Slot,
  type SlotEntryView,
} from "@bb/plugin/app";
import type { ModelReasoningPicker } from "../pickers/ModelReasoningPicker";
import type { PermissionModePicker } from "../pickers/PermissionModePicker";
import type { ProjectSelector } from "../pickers/ProjectSelector";
import type { ThreadContextWindowIndicator } from "bb-plugin-thread-view/contract";
import { SlotMount, useSlotEntries } from "@bb/app-kit/plugins/slots";
import type { PromptBoxAction } from "./PromptBoxActionsMenu";

const UNORDERED = 1_000;

export type ComposerScope = Omit<ComposerContext, "host">;

export interface ComposerMenuHost {
  attach: (() => void) | undefined;
  actions: readonly PromptBoxAction[];
  applyAction: (action: PromptBoxAction) => void;
}

export interface ComposerSendHost {
  queue: boolean;
  submit: (() => void) | undefined;
}

export interface ComposerFooterHost {
  model: ComponentProps<typeof ModelReasoningPicker>;
  permission: ComponentProps<typeof PermissionModePicker>;
  project: ComponentProps<typeof ProjectSelector> | null;
  environment: ReactNode;
  contextWindowUsage:
    | ComponentProps<typeof ThreadContextWindowIndicator>["usage"]
    | null;
}

export function composerMenuHost(context: ComposerContext): ComposerMenuHost {
  return context.host as ComposerMenuHost;
}

export function composerSendHost(context: ComposerContext): ComposerSendHost {
  return context.host as ComposerSendHost;
}

export function composerFooterHost(
  context: ComposerContext,
): ComposerFooterHost {
  return context.host as ComposerFooterHost;
}

interface Available {
  order?: number;
  isAvailable?(context: ComposerContext): boolean;
}

function ordered<Item extends Available>(
  entries: readonly SlotEntryView<Item>[],
): SlotEntryView<Item>[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (a.entry.item.order ?? UNORDERED) - (b.entry.item.order ?? UNORDERED) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

export function useComposerItems<Item extends Available>(
  slot: Slot<Item>,
  context: ComposerContext,
): Item[] {
  const entries = useSlotEntries(slot);
  const sorted = useMemo(() => ordered(entries), [entries]);
  return sorted
    .map(({ item }) => item)
    .filter((item) => item.isAvailable?.(context) ?? true);
}

export function ComposerFooterControls({
  row,
  side,
  context,
}: {
  row: NonNullable<ComposerFooterControl["row"]>;
  side: ComposerFooterControl["side"];
  context: ComposerContext;
}) {
  const entries = useSlotEntries(composer.footerControl);
  const placed = useMemo(
    () =>
      ordered(entries).filter(
        ({ item }) => (item.row ?? "status") === row && item.side === side,
      ),
    [entries, row, side],
  );
  return placed.map(({ plugin, item }) => {
    if (item.isAvailable && !item.isAvailable(context)) return null;
    const View = item.view;
    return (
      <SlotMount
        key={item.id}
        pluginId={plugin}
        slot={composer.footerControl.name}
        id={item.id}
      >
        <View context={context} />
      </SlotMount>
    );
  });
}

export function ComposerBanners({
  composer: handle,
}: {
  composer: ComposerHandle;
}) {
  const entries = useSlotEntries(composer.banner);
  const shown = [...entries]
    .sort(
      (left, right) =>
        (left.item.order ?? UNORDERED) - (right.item.order ?? UNORDERED),
    )
    .filter(({ item }) => item.isAvailable?.(handle) ?? true);
  if (shown.length === 0) return null;
  return (
    <div data-promptbox-banners="" className="border-b border-border">
      {shown.map(({ plugin, item }) => (
        <SlotMount
          key={`${plugin}/${item.id}`}
          pluginId={plugin}
          slot={composer.banner.name}
          id={item.id}
          fallback={null}
        >
          <item.view composer={handle} />
        </SlotMount>
      ))}
    </div>
  );
}
