import type { ReactNode } from "react";
import type { JsonValue } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { PopoverTrigger } from "@bb/shared-ui/popover";

export type EnvironmentInputsChange =
  | { status: "ready"; value: JsonValue }
  | { status: "blocked"; reason: string };

export interface EnvironmentInputsProps {
  projectId: string | null;
  target: { kind: "existing-host"; hostId: string } | { kind: "new-host" };
  value: JsonValue | null;
  onChange(next: EnvironmentInputsChange): void;
}

export function filterBranches(
  branches: readonly string[],
  query: string,
): string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...branches];
  return branches.filter((branch) => branch.toLowerCase().includes(normalized));
}

export function EnvironmentInputsTrigger({
  ariaLabel,
  disabled,
  open,
  title,
  children,
}: {
  ariaLabel: string;
  disabled: boolean;
  open: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <PopoverTrigger asChild disabled={disabled}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        className={cn(
          LIST_HOVER_TRANSITION,
          OPTION_BASE_CLASS_NAME,
          OPTION_INTERACTIVE_CLASS_NAME,
          OPTION_MUTED_CLASS_NAME,
        )}
      >
        <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME} title={title}>
          <Icon
            name="GitMerge"
            className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
          />
          {children}
        </span>
        <Icon
          name="ChevronDown"
          className={cn(
            "shrink-0 text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
          )}
        />
      </Button>
    </PopoverTrigger>
  );
}
