import * as React from "react";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";

import { cn } from "../../lib/utils";

const HasValueContext = React.createContext(false);

function ToggleGroup({
  className,
  value,
  onValueChange,
  onKeyDown,
  ...props
}: Omit<React.ComponentProps<"div">, "defaultValue"> & {
  type: "single";
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const hasValue = value !== undefined && value !== "";
  return (
    <HasValueContext.Provider value={hasValue}>
      <ToggleGroupPrimitive
        role="radiogroup"
        value={hasValue ? [value] : []}
        onValueChange={([next = ""]) => onValueChange?.(next)}
        className={cn("flex items-center justify-center gap-1", className)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          const key = { ArrowDown: "ArrowRight", ArrowUp: "ArrowLeft" }[
            event.key
          ];
          if (!key) return;
          event.preventDefault();
          event.target.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
          );
        }}
        {...props}
      />
    </HasValueContext.Provider>
  );
}

function ToggleGroupItem({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Toggle>, "className" | "render"> & {
  className?: string;
}) {
  const hasValue = React.useContext(HasValueContext);
  return (
    <Toggle
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_[data-icon-root]]:pointer-events-none [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0 bg-transparent h-9 px-2 min-w-9",
        className,
      )}
      render={(renderProps, { pressed }) => (
        <button
          {...renderProps}
          role="radio"
          aria-checked={pressed}
          aria-pressed={undefined}
          data-state={pressed ? "on" : "off"}
          tabIndex={hasValue ? (pressed ? 0 : -1) : renderProps.tabIndex}
        />
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
