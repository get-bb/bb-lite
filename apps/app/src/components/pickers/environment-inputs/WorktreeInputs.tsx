import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { JsonValue } from "@bb/domain";
import {
  BRANCH_PICKER_CONTENT_CLASS_NAME,
  BranchPickerRow,
  BranchPickerSearch,
  BranchPickerSectionHeader,
} from "@bb/shared-ui/branch-picker-primitives";
import { cn } from "@bb/shared-ui/lib/utils";
import { MenuHoverProvider } from "@bb/shared-ui/menu-item-hover";
import { blurActiveKeyboardInputWithin } from "@bb/shared-ui/overlay-trigger";
import { Popover, PopoverContent } from "@bb/shared-ui/popover";
import {
  EnvironmentInputsTrigger,
  filterBranches,
  type EnvironmentInputsProps,
} from "./environment-inputs";
import { useProjectBranches } from "./useProjectBranchState";

const DEFAULT_INPUTS: JsonValue = { branch: { kind: "default" } };
const BRANCH_FROM_PREFIX = "Branch from:";
const REUSE_PREFIX = "Reuse:";

function selectedBranchName(value: JsonValue | null): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const branch = value.branch;
  if (typeof branch !== "object" || branch === null || Array.isArray(branch)) {
    return null;
  }
  return branch.kind === "named" && typeof branch.name === "string"
    ? branch.name
    : null;
}

function selectedExistingPath(value: JsonValue | null): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value.kind === "existing" && typeof value.path === "string"
    ? value.path
    : null;
}

function worktreePathLabel(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/") || path;
}

export function WorktreeInputs({
  projectId,
  target,
  value,
  onChange,
}: EnvironmentInputsProps) {
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionsScrollRef = useRef<HTMLDivElement>(null);

  const existingPath = selectedExistingPath(value);
  const branchName = selectedBranchName(value);

  const branchState = useProjectBranches({
    hostId,
    projectId,
    query: deferredQuery.trim().toLowerCase(),
  });

  useEffect(() => {
    if (value === null) onChange({ status: "ready", value: DEFAULT_INPUTS });
  }, [value, onChange]);

  useEffect(() => {
    if (optionsScrollRef.current) optionsScrollRef.current.scrollTop = 0;
  }, [query]);

  const branchOptions = useMemo(
    () =>
      filterBranches(
        [...new Set([...branchState.branches, ...branchState.remoteBranches])],
        deferredQuery,
      ),
    [branchState.branches, branchState.remoteBranches, deferredQuery],
  );

  const baseBranchLabel =
    branchName ?? branchState.defaultWorktreeBaseBranch ?? "default";
  const triggerPrefix =
    existingPath === null ? BRANCH_FROM_PREFIX : REUSE_PREFIX;
  const triggerValue =
    existingPath === null ? baseBranchLabel : worktreePathLabel(existingPath);
  const triggerTitle =
    existingPath ?? `Create a worktree from ${baseBranchLabel}`;

  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      blurActiveKeyboardInputWithin(inputRef.current);
      setQuery("");
    } else {
      void branchState.refresh().catch(() => undefined);
    }
    setOpen(nextOpen);
  };
  const submit = (next: JsonValue) => {
    onChange({ status: "ready", value: next });
    updateOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <EnvironmentInputsTrigger
        ariaLabel="Worktree"
        disabled={projectId === null}
        open={open}
        title={triggerTitle}
      >
        <span className="flex min-w-0 items-baseline gap-1 truncate">
          <span
            data-promptbox-hide-compact=""
            className="shrink-0 text-muted-foreground"
          >
            {triggerPrefix}
          </span>
          <span className="min-w-0 truncate font-medium text-foreground">
            {triggerValue}
          </span>
        </span>
      </EnvironmentInputsTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        mobileTitle="Branch from:"
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
            ref={optionsScrollRef}
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:h-80"
            onWheel={(event) => event.stopPropagation()}
          >
            <BranchPickerSectionHeader label="Branch from:" />
            <BranchPickerRow
              icon="GitMerge"
              selected={existingPath === null && branchName === null}
              title="Use the repository's default branch"
              onSelect={() => submit(DEFAULT_INPUTS)}
            >
              <span className="min-w-0 flex-1 truncate">Default branch</span>
            </BranchPickerRow>
            {branchOptions.map((branch) => (
              <BranchPickerRow
                key={branch}
                icon="GitMerge"
                selected={branch === branchName}
                title={branch}
                onSelect={() =>
                  submit({ branch: { kind: "named", name: branch } })
                }
              >
                <span className="min-w-0 flex-1 truncate">{branch}</span>
              </BranchPickerRow>
            ))}
            {branchOptions.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {branchState.isLoading
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
