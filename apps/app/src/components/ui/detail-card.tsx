import { type ReactNode, type UIEventHandler } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export function DetailRowIconLabel({
  icon,
  children,
}: {
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export const DETAIL_GRID_CLASS =
  "grid grid-cols-[var(--detail-label-width,96px)_minmax(0,1fr)] gap-x-3";

export function DetailCard({
  children,
  className,
  onScroll,
}: {
  children: ReactNode;
  className?: string;
  onScroll?: UIEventHandler<HTMLDListElement>;
}) {
  return (
    <dl onScroll={onScroll} className={cn("flex flex-col gap-1", className)}>
      {children}
    </dl>
  );
}

export function DetailRow({
  label,
  children,
  className,
  labelClassName,
  valueClassName,
  align = "center",
  orientation = "horizontal",
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  align?: "start" | "center";
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div
      className={
        orientation === "vertical"
          ? cn("flex flex-col gap-1 py-0.5", className)
          : cn(
              DETAIL_GRID_CLASS,
              align === "center" ? "items-center py-0.5" : "py-0.5",
              className,
            )
      }
    >
      <dt
        className={cn(
          "m-0 text-xs leading-5 text-muted-foreground",
          labelClassName,
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "m-0 min-w-0 text-xs leading-5 text-foreground",
          valueClassName,
        )}
      >
        {children}
      </dd>
    </div>
  );
}
