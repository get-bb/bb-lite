import * as React from "react";

import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      autoComplete="off"
      className={cn(
        `flex w-full rounded-md border border-input bg-transparent pl-3 pr-3 py-1 ${CONTROL_HOVER_TRANSITION} file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50`,
        "h-9",
        "text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
