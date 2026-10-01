import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";

export type ResourceDetailSurface = "raised" | "recessed" | "flat";

export function ResourceDetailPanel({
  children,
  className,
  surface = "raised",
}: {
  children: ReactNode;
  className?: string;
  surface?: ResourceDetailSurface;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden",
        surface === "raised" &&
          "rounded-md border border-border bg-surface-raised shadow-sm",
        surface === "recessed" &&
          "rounded-md border border-border bg-surface-recessed/70",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ResourceDetailStack({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "divide-y divide-border/80 [&>[data-resource-detail-section]]:py-6 [&>[data-resource-detail-section]:first-child]:pt-0 [&>[data-resource-detail-section]:last-child]:pb-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
