import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEventHandler,
} from "react";
import {
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DndContextProps,
  type DragEndEvent,
  type DragStartEvent,
  type SensorProps,
  type TouchSensorOptions,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  useDragClickSuppression,
  type ConsumeDragClickSuppression,
} from "./hooks/use-drag-click-suppression.js";

export const reorderCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

export type ReorderDndContextProps = Pick<
  DndContextProps,
  | "sensors"
  | "collisionDetection"
  | "onDragStart"
  | "onDragMove"
  | "onDragOver"
  | "onDragCancel"
  | "onDragEnd"
  | "modifiers"
  | "measuring"
>;

function setSidebarDraggingCursor(active: boolean): void {
  if (active) {
    document.body.dataset.sidebarDragging = "true";
    return;
  }
  delete document.body.dataset.sidebarDragging;
}

const TOUCH_DRAG_DISTANCE_PX = 12;
const TOUCH_HOLD_TOLERANCE_PX = 6;

class SidebarTouchSensor {
  static activators = TouchSensor.activators;

  autoScrollEnabled = true;
  private readonly props: SensorProps<TouchSensorOptions>;
  private readonly document: Document;
  private readonly activator: HTMLElement | null;
  private readonly armedChip: HTMLElement | null;
  private readonly initialCoordinates: { x: number; y: number };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armed = false;
  private dragging = false;

  constructor(props: SensorProps<TouchSensorOptions>) {
    this.props = props;
    const event = props.event;
    if (!(event instanceof TouchEvent) || event.touches.length !== 1) {
      throw new Error("SidebarTouchSensor requires a single touch");
    }
    const touch = event.touches[0];
    this.initialCoordinates = { x: touch.clientX, y: touch.clientY };
    this.document =
      event.target instanceof Node
        ? (event.target.ownerDocument ?? document)
        : document;
    this.activator =
      props.activeNode.activatorNode.current ?? props.activeNode.node.current;
    this.armedChip =
      this.activator?.querySelector("[data-sidebar-touch-armed-chip]") ?? null;
    this.document.addEventListener("touchmove", this.handleMove, {
      passive: false,
    });
    this.document.addEventListener("touchend", this.handleEnd);
    this.document.addEventListener("touchcancel", this.handleCancel);
    this.document.addEventListener("keydown", this.handleKeyDown);
    this.document.addEventListener("visibilitychange", this.handleCancel);
    this.document.defaultView?.addEventListener("blur", this.handleCancel);
    this.document.defaultView?.addEventListener("resize", this.handleCancel);
    const constraint = props.options.activationConstraint;
    const delay = constraint && "delay" in constraint ? constraint.delay : 500;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armed = true;
      this.activator?.setAttribute("data-sidebar-touch-armed", "true");
      if (this.armedChip) {
        const rect = this.armedChip.getBoundingClientRect();
        this.armedChip.style.transform = `translate(${this.initialCoordinates.x - rect.left - rect.width / 2}px, ${this.initialCoordinates.y - rect.top - rect.height / 2}px)`;
      }
    }, delay);
  }

  private readonly handleMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1) {
      this.handleCancel();
      return;
    }
    const coordinates = { x: touch.clientX, y: touch.clientY };
    const distance = Math.hypot(
      coordinates.x - this.initialCoordinates.x,
      coordinates.y - this.initialCoordinates.y,
    );
    if (!this.armed && !this.dragging) {
      if (distance > TOUCH_HOLD_TOLERANCE_PX) this.handleCancel();
      return;
    }
    if (!this.dragging) {
      if (distance <= TOUCH_DRAG_DISTANCE_PX) return;
      this.dragging = true;
      this.activator?.removeAttribute("data-sidebar-touch-armed");
      this.props.onStart(this.initialCoordinates);
    }
    if (event.cancelable) event.preventDefault();
    this.props.onMove(coordinates);
  };

  private readonly handleEnd = (): void => {
    this.detach();
    if (!this.dragging) this.props.onAbort(this.props.active);
    this.props.onEnd();
  };

  private readonly handleCancel = (): void => {
    this.detach();
    if (!this.dragging) this.props.onAbort(this.props.active);
    this.props.onCancel();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Escape") this.handleCancel();
  };

  private detach(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.activator?.removeAttribute("data-sidebar-touch-armed");
    this.armedChip?.style.removeProperty("transform");
    this.document.removeEventListener("touchmove", this.handleMove);
    this.document.removeEventListener("touchend", this.handleEnd);
    this.document.removeEventListener("touchcancel", this.handleCancel);
    this.document.removeEventListener("keydown", this.handleKeyDown);
    this.document.removeEventListener("visibilitychange", this.handleCancel);
    this.document.defaultView?.removeEventListener("blur", this.handleCancel);
    this.document.defaultView?.removeEventListener("resize", this.handleCancel);
  }

  static setup(): () => void {
    if (typeof window === "undefined") {
      return () => {};
    }
    const noop = () => {};
    window.addEventListener("touchmove", noop, {
      capture: false,
      passive: false,
    });
    return () => {
      window.removeEventListener("touchmove", noop);
    };
  }
}

export function useSidebarReorderDnd({
  onDragEnd,
  onDragStart,
  onDragMove,
  onDragOver,
  onDragCancel,
  collisionDetection,
  measuring,
}: Pick<
  ReorderDndContextProps,
  "onDragMove" | "onDragOver" | "collisionDetection" | "measuring"
> & {
  onDragEnd: (event: DragEndEvent) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragCancel?: () => void;
}): {
  dndContextProps: ReorderDndContextProps;
  consumeClickSuppression: ConsumeDragClickSuppression;
  onClickCapture: MouseEventHandler<HTMLElement>;
} {
  const {
    beginDragClickSuppression,
    clearDragClickSuppressionSoon,
    consumeDragClickSuppression,
  } = useDragClickSuppression();
  const isDraggingRef = useRef(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(SidebarTouchSensor, {
      activationConstraint: { delay: 500, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      isDraggingRef.current = true;
      beginDragClickSuppression();
      setSidebarDraggingCursor(true);
      onDragStart?.(event);
    },
    [beginDragClickSuppression, onDragStart],
  );
  const handleDragCancel = useCallback(() => {
    if (!isDraggingRef.current) {
      return;
    }
    isDraggingRef.current = false;
    clearDragClickSuppressionSoon();
    setSidebarDraggingCursor(false);
    onDragCancel?.();
  }, [clearDragClickSuppressionSoon, onDragCancel]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      isDraggingRef.current = false;
      clearDragClickSuppressionSoon();
      setSidebarDraggingCursor(false);
      onDragEnd(event);
    },
    [clearDragClickSuppressionSoon, onDragEnd],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code === "Escape") {
        handleDragCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      isDraggingRef.current = false;
    };
  }, [handleDragCancel]);
  useEffect(() => () => setSidebarDraggingCursor(false), []);
  const onClickCapture = useCallback<MouseEventHandler<HTMLElement>>(
    (event) => {
      if (!consumeDragClickSuppression()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeDragClickSuppression],
  );
  const dndContextProps = useMemo<ReorderDndContextProps>(
    () => ({
      sensors,
      collisionDetection,
      measuring,
      modifiers: [],
      onDragStart: handleDragStart,
      onDragMove,
      onDragOver,
      onDragCancel: handleDragCancel,
      onDragEnd: handleDragEnd,
    }),
    [
      collisionDetection,
      handleDragCancel,
      handleDragEnd,
      handleDragStart,
      measuring,
      onDragMove,
      onDragOver,
      sensors,
    ],
  );

  return {
    dndContextProps,
    consumeClickSuppression: consumeDragClickSuppression,
    onClickCapture,
  };
}
