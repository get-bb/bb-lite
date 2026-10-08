import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useResetPickerScroll } from "./picker-search";
import type { JsonValue, WorkspaceGitOperation } from "@bb/domain";
import {
  BRANCH_PICKER_CONTENT_CLASS_NAME,
  BranchPickerRow,
  BranchPickerSearch,
  BranchPickerSectionHeader,
} from "@bb/shared-ui/branch-picker-primitives";
import { Button } from "@bb/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
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
import { useProjectSourceBranches } from "@bb/app-kit/hooks/queries/project-queries";

export type EnvironmentInputsChange =
  | { status: "ready"; value: JsonValue }
  | { status: "blocked"; reason: string };

interface EnvironmentInputsProps {
  projectId: string | null;
  hostId: string | null;
  value: JsonValue | null;
  onChange(next: EnvironmentInputsChange): void;
}

interface CheckoutState {
  isGit: boolean | null;
  unborn: boolean;
  detached: boolean;
  dirty: boolean;
  currentBranch: string | null;
  operation: WorkspaceGitOperation;
}

type CheckoutBranchSelection =
  | { kind: "existing"; name: string }
  | { kind: "new"; baseBranch: string };

const DEFAULT_WORKTREE_INPUTS: JsonValue = { branch: { kind: "default" } };
const CREATE_NEW_BRANCH_LABEL = "New branch";
const BRANCH_LABEL_PREFIXES = ["Current:", "Checkout:", "New branch from:"];
const CURRENT_PARENTHESES_LABEL_PREFIX = "Current (";

function asRecord(value: JsonValue | null | undefined) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function useBranchPicker(hostId: string | null, projectId: string | null) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim().toLowerCase();
  const inputRef = useRef<HTMLInputElement>(null);
  const enabled = hostId !== null && projectId !== null;
  const branchesQuery = useProjectSourceBranches(
    projectId ?? undefined,
    hostId,
    { enabled, query: deferredQuery, selectedBranch: "" },
  );
  const data = enabled ? branchesQuery.data : undefined;
  const filter = (branches: readonly string[]) =>
    branches.filter((branch) => branch.toLowerCase().includes(deferredQuery));
  return {
    open,
    query,
    setQuery,
    inputRef,
    localBranches: filter(data?.branches ?? []),
    allBranches: filter([
      ...new Set([...(data?.branches ?? []), ...(data?.remoteBranches ?? [])]),
    ]),
    defaultWorktreeBaseBranch: data?.defaultWorktreeBaseBranch ?? null,
    isLoading: enabled && branchesQuery.isFetching,
    changeOpen: (nextOpen: boolean) => {
      if (!nextOpen) {
        blurActiveKeyboardInputWithin(inputRef.current);
        setQuery("");
      } else if (enabled) {
        void branchesQuery.refreshFromRemote().catch(() => {});
      }
      setOpen(nextOpen);
    },
  };
}

function EnvironmentInputsTrigger({
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

function BranchListEmpty({
  isLoading,
  emptyLabel = "No branches found.",
}: {
  isLoading: boolean;
  emptyLabel?: string;
}) {
  return (
    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
      {isLoading ? "Loading branches..." : emptyLabel}
    </p>
  );
}

export function WorktreeInputs({
  projectId,
  hostId,
  value,
  onChange,
}: EnvironmentInputsProps) {
  const picker = useBranchPicker(hostId, projectId);
  const scrollRef = useResetPickerScroll<HTMLDivElement>(picker.query);
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

  const branchOptions = picker.allBranches;
  const baseBranchLabel =
    branchName ?? picker.defaultWorktreeBaseBranch ?? "default";
  const submit = (next: JsonValue) => {
    onChange({ status: "ready", value: next });
    picker.changeOpen(false);
  };

  return (
    <Popover open={picker.open} onOpenChange={picker.changeOpen}>
      <EnvironmentInputsTrigger
        ariaLabel="Worktree"
        disabled={projectId === null}
        open={picker.open}
        title={`Create a worktree from ${baseBranchLabel}`}
      >
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
      </EnvironmentInputsTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        mobileTitle="Work in:"
        autoFocusRef={picker.inputRef}
        className={cn(BRANCH_PICKER_CONTENT_CLASS_NAME, "md:w-72")}
      >
        <MenuHoverProvider>
          <BranchPickerSearch
            inputRef={picker.inputRef}
            query={picker.query}
            enterSelection={branchOptions[0]}
            onEnterSelection={(name) =>
              submit({ branch: { kind: "named", name } })
            }
            onQueryChange={picker.setQuery}
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
              <BranchListEmpty isLoading={picker.isLoading} />
            ) : null}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}

function checkoutBlocker(
  state: CheckoutState,
): { reason: string; guidance: string } | null {
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
  return state.isGit === null ? "Checking checkout" : "Unknown checkout";
}

function CheckoutBranchText({
  label,
  className,
  inTrigger = false,
}: {
  label: string;
  className: string;
  inTrigger?: boolean;
}) {
  const valueClassName = inTrigger
    ? "min-w-0 truncate"
    : "min-w-0 whitespace-normal break-words";
  const affixProps = inTrigger ? { "data-promptbox-hide-compact": "" } : {};
  const affixClassName = "shrink-0 text-muted-foreground";
  if (label === CREATE_NEW_BRANCH_LABEL) {
    return (
      <span className={cn("flex min-w-0 items-baseline gap-1", className)}>
        <span className={valueClassName}>New</span>
        <span {...affixProps} className={affixClassName}>
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
        !inTrigger && "flex-wrap",
        className,
      )}
    >
      <span {...affixProps} className={affixClassName}>
        {prefix}
      </span>
      <span className={cn(valueClassName, "font-medium text-foreground")}>
        {parenthetical
          ? label.slice(prefix.length, -1)
          : label.slice(prefix.length + 1)}
      </span>
      {parenthetical ? (
        <span {...affixProps} className={affixClassName}>
          )
        </span>
      ) : null}
    </span>
  );
}

export function CheckoutInputs({
  projectId,
  hostId,
  value,
  onChange,
}: EnvironmentInputsProps) {
  const picker = useBranchPicker(hostId, projectId);
  const { query } = picker;
  const record = asRecord(value);
  const path = typeof record?.path === "string" ? record.path : null;
  const rawBranch = asRecord(record?.branch);
  const branch: CheckoutBranchSelection | null =
    rawBranch?.kind === "existing" && typeof rawBranch.name === "string"
      ? { kind: "existing", name: rawBranch.name }
      : rawBranch?.kind === "new" && typeof rawBranch.baseBranch === "string"
        ? { kind: "new", baseBranch: rawBranch.baseBranch }
        : null;
  const selectedIntent =
    branch?.kind === "new"
      ? "new"
      : branch?.kind === "existing"
        ? "checkout"
        : "current";
  const [intent, setIntent] = useState<"current" | "new" | "checkout">(
    selectedIntent,
  );
  const checkoutQuery = useProjectSourceBranches(
    projectId ?? undefined,
    hostId,
    {
      enabled: hostId !== null && projectId !== null,
      query: "",
      selectedBranch: "",
    },
  );
  const head = checkoutQuery.data?.checkout;
  const checkout: CheckoutState = {
    isGit: head === undefined ? null : head.kind !== "unknown",
    unborn: head?.kind === "unborn",
    detached: head?.kind === "detached",
    dirty: checkoutQuery.data?.hasUncommittedChanges ?? false,
    currentBranch: head?.kind === "branch" ? head.branchName : null,
    operation: checkoutQuery.data?.operation ?? { kind: "none" },
  };
  const blocker = checkoutBlocker(checkout);
  const buildInputs = (next: CheckoutBranchSelection | null): JsonValue => ({
    ...(path === null ? {} : { path }),
    ...(next === null ? {} : { branch: next }),
  });
  const inputsKey = JSON.stringify(buildInputs(branch));
  const blockedReason = branch !== null ? (blocker?.reason ?? null) : null;

  useEffect(() => {
    onChange(
      blockedReason !== null
        ? { status: "blocked", reason: blockedReason }
        : { status: "ready", value: JSON.parse(inputsKey) as JsonValue },
    );
  }, [blockedReason, inputsKey, onChange]);
  useEffect(() => {
    if (picker.open) setIntent(selectedIntent);
  }, [picker.open, selectedIntent]);
  const scrollRef = useResetPickerScroll<HTMLDivElement>(`${intent}\0${query}`);

  const selectedBranchName =
    branch?.kind === "existing"
      ? branch.name
      : branch?.kind === "new"
        ? branch.baseBranch
        : null;
  const filteredBranches =
    intent === "new" ? picker.allBranches : picker.localBranches;
  const branchOptions =
    query.trim().length === 0 &&
    selectedBranchName !== null &&
    filteredBranches.includes(selectedBranchName)
      ? [
          selectedBranchName,
          ...filteredBranches.filter((name) => name !== selectedBranchName),
        ]
      : filteredBranches;
  const currentLabel = currentMenuLabel(checkout);
  const showBranchChooser = intent !== "current";
  const showSearch = showBranchChooser && blocker === null;
  const updateBranch = (next: CheckoutBranchSelection | null) =>
    onChange({ status: "ready", value: buildInputs(next) });
  const selectBranch = (name: string) => {
    updateBranch(
      intent === "new"
        ? { kind: "new", baseBranch: name }
        : { kind: "existing", name },
    );
    picker.changeOpen(false);
  };

  return (
    <Popover open={picker.open} onOpenChange={picker.changeOpen}>
      <EnvironmentInputsTrigger
        ariaLabel="Branch"
        disabled={projectId === null}
        open={picker.open}
        title={
          blocker?.reason ??
          (branch?.kind === "existing"
            ? `Checkout branch: ${branch.name}`
            : branch?.kind === "new"
              ? `Create a new branch from ${branch.baseBranch}`
              : currentLabel)
        }
      >
        <CheckoutBranchText
          label={
            branch?.kind === "existing"
              ? `Checkout: ${branch.name}`
              : branch?.kind === "new"
                ? `New branch from: ${branch.baseBranch}`
                : checkout.currentBranch === null
                  ? currentLabel
                  : `Current (${checkout.currentBranch})`
          }
          className="truncate"
          inTrigger
        />
      </EnvironmentInputsTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        mobileTitle="Start from:"
        autoFocusRef={showSearch ? picker.inputRef : undefined}
        className={cn(
          BRANCH_PICKER_CONTENT_CLASS_NAME,
          showSearch && "md:min-w-40",
        )}
      >
        <MenuHoverProvider>
          {showSearch ? (
            <BranchPickerSearch
              inputRef={picker.inputRef}
              query={query}
              enterSelection={branchOptions[0]}
              onEnterSelection={selectBranch}
              onQueryChange={picker.setQuery}
              ariaLabel="Search branches"
            />
          ) : null}
          <div
            ref={scrollRef}
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:max-h-80"
            onWheel={(event) => event.stopPropagation()}
          >
            <BranchPickerSectionHeader label="Start from:" sticky={false} />
            <BranchPickerRow
              icon="GitMerge"
              selected={intent === "current"}
              title={currentLabel}
              onSelect={() => {
                setIntent("current");
                updateBranch(null);
                picker.changeOpen(false);
              }}
            >
              <CheckoutBranchText label={currentLabel} className="flex-1" />
            </BranchPickerRow>
            <BranchPickerRow
              disabled={blocker !== null}
              icon="Plus"
              selected={intent === "new"}
              title={blocker?.reason ?? CREATE_NEW_BRANCH_LABEL}
              onSelect={() => {
                setIntent("new");
                const baseBranch = selectedBranchName ?? checkout.currentBranch;
                if (baseBranch !== null) {
                  updateBranch({ kind: "new", baseBranch });
                }
              }}
            >
              <CheckoutBranchText
                label={CREATE_NEW_BRANCH_LABEL}
                className="flex-1"
              />
            </BranchPickerRow>
            <BranchPickerRow
              disabled={blocker !== null}
              icon="GitMerge"
              selected={intent === "checkout"}
              title={blocker?.reason ?? "Checkout an existing branch"}
              onSelect={() => setIntent("checkout")}
            >
              <CheckoutBranchText label="Checkout" className="flex-1" />
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
                  label={intent === "new" ? "Branch from:" : "Checkout:"}
                />
                {blocker !== null
                  ? null
                  : branchOptions.map((name) => (
                      <BranchPickerRow
                        key={name}
                        icon="GitMerge"
                        selected={name === selectedBranchName}
                        title={name}
                        onSelect={() => selectBranch(name)}
                      >
                        <CheckoutBranchText label={name} className="flex-1" />
                      </BranchPickerRow>
                    ))}
                {blocker === null && branchOptions.length === 0 ? (
                  <BranchListEmpty
                    isLoading={picker.isLoading}
                    emptyLabel={
                      intent === "checkout"
                        ? "No local branches found."
                        : undefined
                    }
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}
