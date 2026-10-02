import type { ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { SettingsRowList } from "@/components/ui/settings-section";

const VERTICAL_ONLY: Modifier[] = [({ transform }) => ({ ...transform, x: 0 })];

export function SortableSettingsRowList({
  ids,
  disabled,
  onReorder,
  children,
}: {
  ids: string[];
  disabled: boolean;
  onReorder: (activeId: string, overId: string) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={VERTICAL_ONLY}
      onDragEnd={({ active, over }) => {
        if (!disabled && typeof active.id === "string" && over)
          onReorder(active.id, String(over.id));
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <SettingsRowList>{children}</SettingsRowList>
      </SortableContext>
    </DndContext>
  );
}

export function useSortableSettingsRow({
  id,
  disabled,
  label,
}: {
  id: string;
  disabled: boolean;
  label: string;
}) {
  const sortable = useSortable({ id, disabled });
  const handle = (
    <Button
      ref={sortable.setActivatorNodeRef}
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "-ml-2 h-8 w-7 shrink-0 touch-none text-muted-foreground",
        !disabled && "cursor-grab active:cursor-grabbing",
      )}
      disabled={disabled}
      aria-label={`Reorder ${label}`}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <Icon name="DragDropVertical" aria-hidden="true" />
    </Button>
  );
  return {
    setNodeRef: sortable.setNodeRef,
    style: {
      transform: CSS.Translate.toString(sortable.transform),
      transition: sortable.transition,
    },
    isDragging: sortable.isDragging,
    handle,
  };
}
