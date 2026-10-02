import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

const PILL_VARIANT_CLASS = {
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
  outline: "border-border bg-background text-foreground",
};

export function Pill({
  variant,
  size = "default",
  className,
  children,
}: {
  variant: keyof typeof PILL_VARIANT_CLASS;
  size?: "default" | "sm";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border text-xs",
        size === "sm" ? "px-1.5 py-0" : "px-2 py-0.5",
        PILL_VARIANT_CLASS[variant],
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
