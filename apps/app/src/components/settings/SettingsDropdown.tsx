import type { ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Switch } from "@bb/shared-ui/switch";
import { cn } from "@bb/shared-ui/lib/utils";
import { SettingsWithControl } from "@/components/ui/settings-section";

export function SettingsSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsWithControl label={label} description={description}>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </SettingsWithControl>
  );
}

export function SettingsDropdown<Value extends string | boolean>({
  label,
  description,
  disabled,
  trigger,
  value,
  options,
  onSelect,
  onOpenChange,
  onPreview,
  contentClassName,
  footer,
}: {
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  trigger: ReactNode;
  value: Value;
  options: readonly { value: Value; content: ReactNode; className?: string }[];
  onSelect: (value: Value) => void;
  onOpenChange?: (open: boolean) => void;
  onPreview?: (value: Value | null) => void;
  contentClassName?: string;
  footer?: ReactNode;
}) {
  return (
    <SettingsWithControl label={label} description={description}>
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full justify-between border-border/60 bg-card px-2 text-xs sm:w-36"
            aria-label={label}
            disabled={disabled}
          >
            {trigger}
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={cn(
            "min-w-[var(--radix-dropdown-menu-trigger-width)]",
            contentClassName,
          )}
        >
          {options.map((option) => (
            <DropdownMenuItem
              key={String(option.value)}
              className={option.className}
              onFocus={onPreview && (() => onPreview(option.value))}
              onBlur={onPreview && (() => onPreview(null))}
              onSelect={() => onSelect(option.value)}
            >
              {option.content}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  value !== option.value && "opacity-0",
                  "size-4",
                )}
              />
            </DropdownMenuItem>
          ))}
          {footer}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}
