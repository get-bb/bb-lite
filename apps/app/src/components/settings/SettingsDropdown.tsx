import type { ReactNode } from "react";
import { Link } from "react-router-dom";
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
import { PageShell } from "@/components/ui/page-shell.js";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { getSettingsSectionRoutePath } from "./settings-sections";

export function SettingsDetailShell({
  section,
  label,
  children,
}: {
  section: "machines" | "projects";
  label: string;
  children: ReactNode;
}) {
  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-3">
        <SettingsBackLink section={section} label={label} />
        {children}
      </div>
    </PageShell>
  );
}

export function SettingsBackLink({
  section,
  label,
}: {
  section: "machines" | "projects";
  label: string;
}) {
  return (
    <Link
      to={getSettingsSectionRoutePath(section)}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <Icon name="ChevronLeft" className="size-3.5" />
      {label}
    </Link>
  );
}

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
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}
