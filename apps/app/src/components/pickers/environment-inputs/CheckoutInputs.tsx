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
import {
  useCheckoutState,
  useProjectBranches,
  type CheckoutState,
} from "./useProjectBranchState";

const CREATE_NEW_BRANCH_LABEL = "New branch";
const BRANCH_LABEL_PREFIXES = [
  "Current:",
  "Checkout:",
  "New branch from:",
] as const;
const CURRENT_PARENTHESES_LABEL_PREFIX = "Current (";

type CheckoutBranchSelection =
  | { kind: "existing"; name: string }
  | { kind: "new"; baseBranch: string };

interface CheckoutInputsValue {
  path: string | null;
  branch: CheckoutBranchSelection | null;
}

interface CheckoutBlocker {
  reason: string;
  guidance: string;
}

type CheckoutIntent = "current" | "new" | "checkout";

function readBranch(
  branch: JsonValue | undefined,
): CheckoutBranchSelection | null {
  if (typeof branch !== "object" || branch === null || Array.isArray(branch)) {
    return null;
  }
  if (branch.kind === "existing" && typeof branch.name === "string") {
    return { kind: "existing", name: branch.name };
  }
  if (branch.kind === "new" && typeof branch.baseBranch === "string") {
    return { kind: "new", baseBranch: branch.baseBranch };
  }
  return null;
}

function readCheckoutInputs(value: JsonValue | null): CheckoutInputsValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { path: null, branch: null };
  }
  return {
    path: typeof value.path === "string" ? value.path : null,
    branch: readBranch(value.branch),
  };
}

function buildCheckoutInputs(inputs: CheckoutInputsValue): JsonValue {
  return {
    ...(inputs.path === null ? {} : { path: inputs.path }),
    ...(inputs.branch === null ? {} : { branch: inputs.branch }),
  };
}

function checkoutBlocker(state: CheckoutState): CheckoutBlocker | null {
  if (state.isGit === null) {
    return {
      reason: "Checking checkout state",
      guidance: "Checking whether branch changes are available…",
    };
  }
  if (!state.isGit) {
    return {
      reason: "Checkout state is unavailable",
      guidance:
        "Branch changes are unavailable because this checkout could not be inspected.",
    };
  }
  if (state.operation.kind !== "none") {
    if (state.operation.hasConflicts) {
      return {
        reason: "Checkout blocked by unresolved conflicts",
        guidance:
          "Resolve the conflicts and finish or abort the Git operation to change branches.",
      };
    }
    const name =
      state.operation.kind === "unknown" ? "operation" : state.operation.kind;
    return {
      reason: `Checkout blocked by an in-progress ${name}`,
      guidance: `Finish or abort the ${name} to change branches.`,
    };
  }
  if (state.dirty) {
    return {
      reason: "Checkout blocked by uncommitted changes",
      guidance:
        "Commit or stash the uncommitted changes in this checkout to create or switch branches.",
    };
  }
  if (state.detached) {
    return {
      reason: "Checkout blocked while HEAD is detached",
      guidance:
        "Attach HEAD to a branch in this checkout to create or switch branches here.",
    };
  }
  if (state.unborn) {
    return {
      reason: "Checkout blocked before the first commit",
      guidance:
        "Create the first commit in this checkout to create or switch branches.",
    };
  }
  return null;
}

function currentMenuLabel(state: CheckoutState): string {
  if (state.currentBranch !== null) return `Current: ${state.currentBranch}`;
  if (state.detached) return "Current (detached)";
  if (state.unborn) return "Current (empty repo)";
  if (state.isGit === null) return "Checking checkout";
  return "Unknown checkout";
}

function currentTriggerLabel(state: CheckoutState): string {
  return state.currentBranch === null
    ? currentMenuLabel(state)
    : `Current (${state.currentBranch})`;
}

function resolveCheckoutIntent(
  branch: CheckoutBranchSelection | null,
): CheckoutIntent {
  if (branch?.kind === "new") return "new";
  if (branch?.kind === "existing") return "checkout";
  return "current";
}

function BranchPickerText({
  label,
  className,
  compactAffixesInPromptbox = false,
  wrap = false,
}: {
  label: string;
  className?: string;
  compactAffixesInPromptbox?: boolean;
  wrap?: boolean;
}) {
  const valueClassName = wrap
    ? "min-w-0 whitespace-normal break-words"
    : "min-w-0 truncate";
  const compactAffixProps = compactAffixesInPromptbox
    ? { "data-promptbox-hide-compact": "" }
    : {};
  if (label === CREATE_NEW_BRANCH_LABEL) {
    return (
      <span className={cn("flex min-w-0 items-baseline gap-1", className)}>
        <span className={valueClassName}>New</span>
        <span {...compactAffixProps} className="shrink-0 text-muted-foreground">
          branch
        </span>
      </span>
    );
  }
  const parenthetical =
    label.startsWith(CURRENT_PARENTHESES_LABEL_PREFIX) && label.endsWith(")");
  const prefix = parenthetical
    ? CURRENT_PARENTHESES_LABEL_PREFIX
    : BRANCH_LABEL_PREFIXES.find((option) => label.startsWith(`${option} `));
  if (prefix === undefined) {
    return <span className={cn(valueClassName, className)}>{label}</span>;
  }
  return (
    <span
      className={cn(
        "flex min-w-0 items-baseline",
        !parenthetical && "gap-1",
        wrap && "flex-wrap",
        className,
      )}
    >
      <span {...compactAffixProps} className="shrink-0 text-muted-foreground">
        {prefix}
      </span>
      <span className={cn(valueClassName, "font-medium text-foreground")}>
        {parenthetical
          ? label.slice(prefix.length, -1)
          : label.slice(prefix.length + 1)}
      </span>
      {parenthetical ? (
        <span {...compactAffixProps} className="shrink-0 text-muted-foreground">
          )
        </span>
      ) : null}
    </span>
  );
}

export function CheckoutInputs({
  projectId,
  target,
  value,
  onChange,
}: EnvironmentInputsProps) {
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const inputs = useMemo(() => readCheckoutInputs(value), [value]);
  const checkout = useCheckoutState({ hostId, projectId });
  const selectedCheckoutIntent = resolveCheckoutIntent(inputs.branch);
  const [checkoutIntent, setCheckoutIntent] = useState<CheckoutIntent>(
    selectedCheckoutIntent,
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const branchState = useProjectBranches({
    hostId,
    projectId,
    query: deferredQuery.trim().toLowerCase(),
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const optionsScrollRef = useRef<HTMLDivElement>(null);
  const blocker = hostId === null ? null : checkoutBlocker(checkout);
  const nextInputs = useMemo(
    () => buildCheckoutInputs(inputs),
    [inputs.branch, inputs.path],
  );
  const blockerReason = blocker?.reason ?? null;

  useEffect(() => {
    if (inputs.branch !== null && blockerReason !== null) {
      onChange({ status: "blocked", reason: blockerReason });
      return;
    }
    onChange({ status: "ready", value: nextInputs });
  }, [blockerReason, inputs.branch, nextInputs, onChange]);

  useEffect(() => {
    if (open) setCheckoutIntent(selectedCheckoutIntent);
  }, [open, selectedCheckoutIntent]);

  useEffect(() => {
    if (optionsScrollRef.current) optionsScrollRef.current.scrollTop = 0;
  }, [checkoutIntent, query]);

  const selectedBranchName =
    inputs.branch?.kind === "existing"
      ? inputs.branch.name
      : inputs.branch?.kind === "new"
        ? inputs.branch.baseBranch
        : null;
  const branchOptions = useMemo(() => {
    const branches =
      hostId === null
        ? branchState.remoteBranches
            .filter((branch) => branch.startsWith("origin/"))
            .map((branch) => branch.slice("origin/".length))
        : checkoutIntent === "new"
          ? [
              ...branchState.branches,
              ...branchState.remoteBranches.filter(
                (branch) => !branchState.branches.includes(branch),
              ),
            ]
          : [...branchState.branches];
    const filtered = filterBranches(branches, deferredQuery);
    const selected = query.trim().length === 0 ? selectedBranchName : null;
    if (selected === null || !filtered.includes(selected)) return filtered;
    return [selected, ...filtered.filter((branch) => branch !== selected)];
  }, [
    hostId,
    branchState.branches,
    branchState.remoteBranches,
    checkoutIntent,
    deferredQuery,
    query,
    selectedBranchName,
  ]);
  const currentOptionLabel =
    hostId === null ? "Default branch" : currentMenuLabel(checkout);
  const showBranchChooser = checkoutIntent !== "current";
  const showOptionsSearch = showBranchChooser && blocker === null;
  const triggerLabel =
    inputs.branch?.kind === "existing"
      ? `Checkout: ${inputs.branch.name}`
      : inputs.branch?.kind === "new"
        ? `New branch from: ${inputs.branch.baseBranch}`
        : hostId === null
          ? "Default branch"
          : currentTriggerLabel(checkout);
  const triggerTitle =
    blocker?.reason ??
    (inputs.branch?.kind === "existing"
      ? `Checkout branch: ${inputs.branch.name}`
      : inputs.branch?.kind === "new"
        ? `Create a new branch from ${inputs.branch.baseBranch}`
        : hostId === null
          ? "Use the repository’s default branch"
          : currentMenuLabel(checkout));
  const updateBranch = (branch: CheckoutBranchSelection | null) => {
    onChange({
      status: "ready",
      value: buildCheckoutInputs({ path: inputs.path, branch }),
    });
  };
  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      blurActiveKeyboardInputWithin(inputRef.current);
      setQuery("");
    } else {
      void branchState.refresh().catch(() => undefined);
    }
    setOpen(nextOpen);
  };
  const closePicker = () => updateOpen(false);
  const selectBranchAndClose = (branch: string) => {
    updateBranch(
      checkoutIntent === "new"
        ? { kind: "new", baseBranch: branch }
        : { kind: "existing", name: branch },
    );
    closePicker();
  };

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <EnvironmentInputsTrigger
        ariaLabel="Branch"
        disabled={projectId === null}
        open={open}
        title={triggerTitle}
      >
        <BranchPickerText
          label={triggerLabel}
          className="truncate"
          compactAffixesInPromptbox
        />
      </EnvironmentInputsTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        mobileTitle="Start from:"
        autoFocusRef={showOptionsSearch ? inputRef : undefined}
        className={cn(
          BRANCH_PICKER_CONTENT_CLASS_NAME,
          showOptionsSearch && "md:min-w-40",
        )}
      >
        <MenuHoverProvider>
          {showOptionsSearch ? (
            <BranchPickerSearch
              inputRef={inputRef}
              query={query}
              enterSelection={
                branchOptions[0] ?? (hostId === null ? query.trim() : undefined)
              }
              onEnterSelection={selectBranchAndClose}
              onQueryChange={setQuery}
              ariaLabel="Search branches"
            />
          ) : null}
          <div
            ref={optionsScrollRef}
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:max-h-80"
            onWheel={(event) => event.stopPropagation()}
          >
            <BranchPickerSectionHeader label="Start from:" sticky={false} />
            <BranchPickerRow
              icon="GitMerge"
              selected={checkoutIntent === "current"}
              title={currentOptionLabel}
              onSelect={() => {
                setCheckoutIntent("current");
                updateBranch(null);
                closePicker();
              }}
            >
              <BranchPickerText
                label={currentOptionLabel}
                className="flex-1"
                wrap
              />
            </BranchPickerRow>
            <BranchPickerRow
              disabled={blocker !== null}
              icon="Plus"
              selected={checkoutIntent === "new"}
              title={blocker?.reason ?? CREATE_NEW_BRANCH_LABEL}
              onSelect={() => {
                setCheckoutIntent("new");
                const baseBranch = selectedBranchName ?? checkout.currentBranch;
                if (baseBranch !== null) {
                  updateBranch({ kind: "new", baseBranch });
                }
              }}
            >
              <BranchPickerText
                label={CREATE_NEW_BRANCH_LABEL}
                className="flex-1"
                wrap
              />
            </BranchPickerRow>
            <BranchPickerRow
              disabled={blocker !== null}
              icon="GitMerge"
              selected={checkoutIntent === "checkout"}
              title={blocker?.reason ?? "Checkout an existing branch"}
              onSelect={() => setCheckoutIntent("checkout")}
            >
              <BranchPickerText label="Checkout" className="flex-1" wrap />
            </BranchPickerRow>
            {blocker !== null ? (
              <p
                role="status"
                className="px-2 py-2 text-xs leading-snug text-muted-foreground"
              >
                {blocker.guidance}
              </p>
            ) : null}
            {showBranchChooser ? (
              <>
                <div className="my-1 h-px bg-border/60" />
                <BranchPickerSectionHeader
                  label={
                    checkoutIntent === "new" ? "Branch from:" : "Checkout:"
                  }
                />
                {blocker === null ? (
                  <>
                    {branchOptions.map((branch) => (
                      <BranchPickerRow
                        key={branch}
                        icon="GitMerge"
                        selected={branch === selectedBranchName}
                        title={branch}
                        onSelect={() => selectBranchAndClose(branch)}
                      >
                        <BranchPickerText
                          label={branch}
                          className="flex-1"
                          wrap
                        />
                      </BranchPickerRow>
                    ))}
                    {hostId === null &&
                    query.trim() &&
                    !branchOptions.includes(query.trim()) ? (
                      <BranchPickerRow
                        icon="GitMerge"
                        selected={false}
                        title={`Use ${query.trim()}`}
                        onSelect={() => selectBranchAndClose(query.trim())}
                      >
                        <BranchPickerText
                          label={`Use ${query.trim()}`}
                          className="flex-1"
                          wrap
                        />
                      </BranchPickerRow>
                    ) : null}
                    {branchOptions.length === 0 &&
                    !(hostId === null && query.trim()) ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        {branchState.isLoading
                          ? "Loading branches..."
                          : checkoutIntent === "checkout"
                            ? "No local branches found."
                            : "No branches found."}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}
