import type { Host } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export type MachineLabelHost = Pick<Host, "name">;

export function MachineIcon({ className }: { className?: string }) {
  return (
    <Icon
      name="Laptop"
      className={cn("size-3.5 shrink-0", className)}
      aria-hidden
    />
  );
}

export function MachineLabel({
  host,
  className,
  iconClassName,
  nameClassName,
}: {
  host: MachineLabelHost;
  className?: string;
  iconClassName?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <MachineIcon className={iconClassName} />
      <span className={cn("min-w-0 truncate", nameClassName)}>{host.name}</span>
    </span>
  );
}
