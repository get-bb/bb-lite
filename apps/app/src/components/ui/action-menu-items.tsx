import type { ReactNode } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@bb/shared-ui/dropdown-menu";

export function ActionMenuItem({
  children,
  variant,
  icon,
  onSelect,
}: {
  children: ReactNode;
  variant?: "default" | "destructive";
  icon: IconName;
  onSelect?: (event: Event) => void;
}) {
  return (
    <DropdownMenuItem variant={variant} onSelect={onSelect}>
      <Icon name={icon} aria-hidden="true" />
      {children}
    </DropdownMenuItem>
  );
}

export const ActionMenuSeparator = DropdownMenuSeparator;
