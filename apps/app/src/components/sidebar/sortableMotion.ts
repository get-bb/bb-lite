import type { CSSProperties } from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface SidebarSortableDragBindings {
  attributes: DraggableAttributes;
  disabled: boolean;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
}

export function useSidebarSortable({
  id,
  disabled,
}: {
  id: string;
  disabled: boolean;
}): {
  dragBindings: SidebarSortableDragBindings;
  isOver: boolean;
  setNodeRef: (element: HTMLElement | null) => void;
  style: CSSProperties;
} {
  const sortable = useSortable({
    id,
    disabled,
    transition: { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  const { attributes, isDragging, listeners, setActivatorNodeRef } = sortable;
  return {
    dragBindings: { attributes, disabled, listeners, setActivatorNodeRef },
    isOver: sortable.isOver,
    setNodeRef: sortable.setNodeRef,
    style: {
      transform: CSS.Translate.toString(sortable.transform),
      transition: sortable.transition,
      position: isDragging ? "relative" : undefined,
      zIndex: isDragging ? 100 : undefined,
      opacity: isDragging ? 0.8 : undefined,
    },
  };
}
