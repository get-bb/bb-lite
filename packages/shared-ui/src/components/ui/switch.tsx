import * as React from "react";
import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

function Switch({
  checked,
  className,
  onCheckedChange,
  onClick,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange" | "role"> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const state = checked ? "checked" : "unchecked";
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={state}
      className={cn(
        `peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input shadow-xs ${CONTROL_HOVER_TRANSITION} outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-foreground data-[state=unchecked]:border-input data-[state=unchecked]:bg-muted`,
        "h-4 w-7",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
    >
      <span
        aria-hidden
        data-state={state}
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform data-[state=unchecked]:bg-foreground data-[state=unchecked]:translate-x-0",
          "size-3 data-[state=checked]:translate-x-3",
        )}
      />
    </button>
  );
}

export { Switch };
