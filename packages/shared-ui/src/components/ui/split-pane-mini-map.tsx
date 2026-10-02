import { cn } from "../../lib/utils";

const GLYPH_SIZE = 14;
const INNER = GLYPH_SIZE - 2;

export function SplitPaneMiniMap({
  slots,
  label,
  isWorking = false,
}: {
  slots: readonly {
    paneId: string;
    rect: { x: number; y: number; width: number; height: number };
    isMe: boolean;
    isFocused: boolean;
  }[];
  label: string;
  isWorking?: boolean;
}) {
  const representsFocusedPane = slots.some(
    (slot) => slot.isMe && slot.isFocused,
  );

  return (
    <svg
      width={GLYPH_SIZE}
      height={GLYPH_SIZE}
      viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
      className={cn(
        "pointer-events-none !size-3.5 shrink-0",
        !representsFocusedPane && "opacity-60",
        isWorking && "animate-shine-icon",
      )}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      {slots.map((slot) => {
        const inset = slot.isMe ? 0 : 0.5;
        return (
          <rect
            key={slot.paneId}
            x={1 + slot.rect.x * INNER + inset}
            y={1 + slot.rect.y * INNER + inset}
            width={Math.max(slot.rect.width * INNER - 2 * inset, 0)}
            height={Math.max(slot.rect.height * INNER - 2 * inset, 0)}
            strokeWidth={slot.isMe ? 0 : 1}
            className={cn(
              slot.isMe
                ? slot.isFocused
                  ? "fill-primary/70 stroke-none"
                  : "fill-muted-foreground/45 stroke-none"
                : "fill-none stroke-muted-foreground/30",
            )}
          />
        );
      })}
    </svg>
  );
}
