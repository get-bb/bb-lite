export interface SelectionAnchorPoint {
  x: number;
  y: number;
}

export type SelectionAnchorSide = "top" | "bottom";

export interface SelectionAnchor {
  point: SelectionAnchorPoint;
  side: SelectionAnchorSide;
}

export interface MessageProseSelection {
  text: string;
  rect: DOMRect;
  anchorPoint?: SelectionAnchorPoint;
  anchorSide?: SelectionAnchorSide;
}

const SELECTION_DRAG_DIRECTION_THRESHOLD_PX = 4;

export function firstClientRect(range: Range): DOMRect | null {
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
  }
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

export function anchorPointFromMouseEvent(
  event: Pick<MouseEvent, "clientX" | "clientY">,
): SelectionAnchorPoint | null {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
    return null;
  }
  return { x: event.clientX, y: event.clientY };
}

export function selectionAnchorFromPointerRelease(
  startPoint: SelectionAnchorPoint | null,
  releaseEvent: Pick<MouseEvent, "clientX" | "clientY">,
): SelectionAnchor | null {
  const releasePoint = anchorPointFromMouseEvent(releaseEvent);
  if (releasePoint === null) {
    return null;
  }
  return {
    point: releasePoint,
    side:
      startPoint !== null &&
      releasePoint.y - startPoint.y > SELECTION_DRAG_DIRECTION_THRESHOLD_PX
        ? "bottom"
        : "top",
  };
}
