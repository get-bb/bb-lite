import type { ComponentProps, ReactNode } from "react";
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

export function ResourceDetailList({
  children,
  className,
  surface,
}: {
  children: ReactNode;
  className?: string;
  surface?: ResourceDetailSurface;
}) {
  return (
    <ResourceDetailPanel surface={surface} className={cn("p-1", className)}>
      {children}
    </ResourceDetailPanel>
  );
}

export function ResourceDetailCollection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ResourceDetailList
      surface="flat"
      className={cn(
        "divide-y divide-border overflow-hidden rounded-md border border-border bg-background p-0",
        className,
      )}
    >
      {children}
    </ResourceDetailList>
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

export function ResourceSectionTitle({
  className,
  ...props
}: ComponentProps<"h2">) {
  return (
    <h2
      className={cn(
        "text-sm font-medium leading-5 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
