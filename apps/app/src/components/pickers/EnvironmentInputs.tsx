import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useResetPickerScroll } from "./picker-search";
import type { JsonValue } from "@bb/domain";
import {
  BRANCH_PICKER_CONTENT_CLASS_NAME,
  BranchPickerRow,
  BranchPickerSearch,
  BranchPickerSectionHeader,
} from "@bb/shared-ui/branch-picker-primitives";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { MenuHoverProvider } from "@bb/shared-ui/menu-item-hover";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { blurActiveKeyboardInputWithin } from "@bb/shared-ui/overlay-trigger";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { useProjectSourceBranches } from "@/hooks/queries/project-queries";

export type EnvironmentInputsChange =
  | { status: "ready"; value: JsonValue }
  | { status: "blocked"; reason: string };

interface EnvironmentInputsProps {
  projectId: string | null;
  hostId: string | null;
  value: JsonValue | null;
  onChange(next: EnvironmentInputsChange): void;
}

const DEFAULT_WORKTREE_INPUTS: JsonValue = { branch: { kind: "default" } };

function asRecord(value: JsonValue | null | undefined) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

export function WorktreeInputs({
  projectId,
  hostId,
  value,
  onChange,
}: EnvironmentInputsProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim().toLowerCase();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useResetPickerScroll<HTMLDivElement>(query);
  const enabled = hostId !== null && projectId !== null;
  const branchesQuery = useProjectSourceBranches(
    projectId ?? undefined,
    hostId,
    { enabled, query: deferredQuery, selectedBranch: "" },
  );
  const data = enabled ? branchesQuery.data : undefined;
  const branch = asRecord(asRecord(value)?.branch);
  const branchName =
    branch?.kind === "named" && typeof branch.name === "string"
      ? branch.name
      : null;

  useEffect(() => {
    if (value === null) {
      onChange({ status: "ready", value: DEFAULT_WORKTREE_INPUTS });
    }
  }, [value, onChange]);

  const branchOptions = [
    ...new Set([...(data?.branches ?? []), ...(data?.remoteBranches ?? [])]),
  ].filter((option) => option.toLowerCase().includes(deferredQuery));
  const baseBranchLabel =
    branchName ?? data?.defaultWorktreeBaseBranch ?? "default";
  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      blurActiveKeyboardInputWithin(inputRef.current);
      setQuery("");
    } else if (enabled) {
      void branchesQuery.refreshFromRemote().catch(() => {});
    }
    setOpen(nextOpen);
  };
  const submit = (next: JsonValue) => {
    onChange({ status: "ready", value: next });
    changeOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild disabled={projectId === null}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={projectId === null}
          aria-label="Worktree"
          role="combobox"
          aria-expanded={open}
          className={cn(
            LIST_HOVER_TRANSITION,
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            OPTION_MUTED_CLASS_NAME,
          )}
        >
          <span
            className={OPTION_TRIGGER_CONTENT_CLASS_NAME}
            title={`Create a worktree from ${baseBranchLabel}`}
          >
            <Icon name="GitMerge" className="size-3.5 shrink-0" />
            <span className="flex min-w-0 items-baseline gap-1 truncate">
              <span
                data-promptbox-hide-compact=""
                className="shrink-0 text-muted-foreground"
              >
                Branch from:
              </span>
              <span className="min-w-0 truncate font-medium text-foreground">
                {baseBranchLabel}
              </span>
            </span>
          </span>
          <Icon
            name="ChevronDown"
            className="shrink-0 text-muted-foreground size-3.5"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        autoFocusRef={inputRef}
        className={cn(BRANCH_PICKER_CONTENT_CLASS_NAME, "md:w-72")}
      >
        <MenuHoverProvider>
          <BranchPickerSearch
            inputRef={inputRef}
            query={query}
            enterSelection={branchOptions[0]}
            onEnterSelection={(name) =>
              submit({ branch: { kind: "named", name } })
            }
            onQueryChange={setQuery}
            ariaLabel="Search branches"
          />
          <div
            ref={scrollRef}
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:h-80"
            onWheel={(event) => event.stopPropagation()}
          >
            <BranchPickerSectionHeader label="Branch from:" />
            <BranchPickerRow
              icon="GitMerge"
              selected={branchName === null}
              title="Use the repository's default branch"
              onSelect={() => submit(DEFAULT_WORKTREE_INPUTS)}
            >
              <span className="min-w-0 flex-1 truncate">Default branch</span>
            </BranchPickerRow>
            {branchOptions.map((option) => (
              <BranchPickerRow
                key={option}
                icon="GitMerge"
                selected={option === branchName}
                title={option}
                onSelect={() =>
                  submit({ branch: { kind: "named", name: option } })
                }
              >
                <span className="min-w-0 flex-1 truncate">{option}</span>
              </BranchPickerRow>
            ))}
            {branchOptions.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {enabled && branchesQuery.isFetching
                  ? "Loading branches..."
                  : "No branches found."}
              </p>
            ) : null}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}

export function CheckoutInputs({
  projectId,
  hostId,
  value,
  onChange,
}: EnvironmentInputsProps) {
  const checkoutQuery = useProjectSourceBranches(
    projectId ?? undefined,
    hostId,
    {
      enabled: hostId !== null && projectId !== null,
      query: "",
      selectedBranch: "",
    },
  );
  useEffect(() => {
    if (value === null) onChange({ status: "ready", value: {} });
  }, [value, onChange]);

  const head = checkoutQuery.data?.checkout;
  const current =
    head?.kind === "branch"
      ? head.branchName
      : head?.kind === "detached"
        ? "detached"
        : head?.kind === "unborn"
          ? "empty repo"
          : null;
  const fallback =
    head === undefined ? "Checking checkout" : "Unknown checkout";
  const affixProps = {
    "data-promptbox-hide-compact": "",
    className: "shrink-0 text-muted-foreground",
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled
      aria-label="Branch"
      className={cn(
        LIST_HOVER_TRANSITION,
        OPTION_BASE_CLASS_NAME,
        OPTION_MUTED_CLASS_NAME,
        "cursor-default disabled:opacity-100",
      )}
    >
      <span
        className={OPTION_TRIGGER_CONTENT_CLASS_NAME}
        title={
          head?.kind === "branch"
            ? `Current: ${head.branchName}`
            : current === null
              ? fallback
              : `Current (${current})`
        }
      >
        <Icon name="GitMerge" className="size-3.5 shrink-0" />
        {current === null ? (
          <span className="min-w-0 truncate">{fallback}</span>
        ) : (
          <span className="flex min-w-0 items-baseline truncate">
            <span {...affixProps}>Current (</span>
            <span className="min-w-0 truncate font-medium text-foreground">
              {current}
            </span>
            <span {...affixProps}>)</span>
          </span>
        )}
      </span>
    </Button>
  );
}
