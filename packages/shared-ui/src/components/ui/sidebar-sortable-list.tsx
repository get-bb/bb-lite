import { useCallback, type CSSProperties, type ReactNode } from "react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useSidebarSortable,
  type SidebarSortableDragBindings,
} from "./sortable-motion";
import {
  reorderCollisionDetection,
  useSidebarReorderDnd,
} from "./use-reorder-dnd";

export interface SidebarSortableRow {
  setNodeRef: (element: HTMLElement | null) => void;
  style: CSSProperties;
  dragBindings: SidebarSortableDragBindings;
}

export function SidebarSortableList<Item extends { id: string }>({
  items,
  onReorder,
  renderItem,
}: {
  items: readonly Item[];
  onReorder: (activeId: string, overId: string) => void;
  renderItem: (item: Item, row: SidebarSortableRow) => ReactNode;
}) {
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = event.active.id;
      const overId = event.over?.id;
      if (typeof activeId !== "string" || typeof overId !== "string") return;
      if (activeId === overId) return;
      onReorder(activeId, overId);
    },
    [onReorder],
  );
  const { dndContextProps } = useSidebarReorderDnd({
    onDragEnd: handleDragEnd,
    collisionDetection: reorderCollisionDetection,
  });
  return (
    <DndContext {...dndContextProps}>
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        {items.map((item) => (
          <SidebarSortableItem
            key={item.id}
            item={item}
            disabled={items.length < 2}
            renderItem={renderItem}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SidebarSortableItem<Item extends { id: string }>({
  item,
  disabled,
  renderItem,
}: {
  item: Item;
  disabled: boolean;
  renderItem: (item: Item, row: SidebarSortableRow) => ReactNode;
}) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: item.id,
    disabled,
  });
  return renderItem(item, { setNodeRef, style, dragBindings });
}
