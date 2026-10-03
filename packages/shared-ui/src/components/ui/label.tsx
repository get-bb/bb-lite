import * as React from "react";

import { cn } from "../../lib/utils";

function Label({
  className,
  onMouseDown,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      onMouseDown={(event) => {
        if (
          (event.target as Element).closest("button, input, select, textarea")
        ) {
          return;
        }
        onMouseDown?.(event);
        if (!event.defaultPrevented && event.detail > 1) event.preventDefault();
      }}
      {...props}
    />
  );
}

export { Label };
