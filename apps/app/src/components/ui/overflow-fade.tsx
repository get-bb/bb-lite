import { cn } from "@bb/shared-ui/lib/utils";

const TONE_CLASSES = {
  background: { from: "from-background", to: "to-background" },
  sidebar: { from: "from-sidebar", to: "to-sidebar" },
  "surface-raised": {
    from: "from-surface-raised-solid",
    to: "to-surface-raised-solid",
  },
};

const SIZE_CLASSES = {
  default: { height: "h-6", above: "-top-6", below: "-bottom-6", width: "w-6" },
  sm: { height: "h-2", above: "-top-2", below: "-bottom-2", width: "w-2" },
  lg: { height: "h-24", above: "-top-24", below: "-bottom-24", width: "w-24" },
};

export function OverflowFade({
  className,
  placement,
  tone = "background",
  inset = false,
  size = "default",
}: {
  className?: string;
  placement: "above" | "below" | "left" | "right";
  tone?: keyof typeof TONE_CLASSES;
  inset?: boolean;
  size?: keyof typeof SIZE_CLASSES;
}) {
  const { from, to } = TONE_CLASSES[tone];
  const sizes = SIZE_CLASSES[size];
  const layout =
    placement === "left" || placement === "right"
      ? cn(
          "inset-y-0",
          placement === "left" ? "left-0" : "right-0",
          sizes.width,
        )
      : cn(
          "inset-x-0",
          sizes.height,
          inset
            ? placement === "above"
              ? "top-0"
              : "bottom-0"
            : sizes[placement],
        );
  const gradient =
    placement === "left"
      ? `bg-gradient-to-l from-transparent ${to}`
      : placement === "right"
        ? `bg-gradient-to-r from-transparent ${to}`
        : inset && placement === "above"
          ? `bg-gradient-to-b ${from} to-transparent`
          : inset || placement === "above"
            ? `bg-gradient-to-b from-transparent ${to}`
            : `bg-gradient-to-b to-transparent ${from}`;
  return (
    <div
      aria-hidden
      data-overflow-fade={placement}
      data-overflow-fade-tone={tone}
      data-overflow-fade-inset={inset ? "" : undefined}
      className={cn(
        "pointer-events-none absolute",
        layout,
        gradient,
        className,
      )}
    />
  );
}
