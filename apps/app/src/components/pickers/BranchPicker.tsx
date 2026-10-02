import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  BRANCH_PICKER_CONTENT_CLASS_NAME,
  BranchPickerRow,
  BranchPickerSearch,
  BranchPickerSectionHeader,
} from "@bb/shared-ui/branch-picker-primitives";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { MenuHoverProvider } from "@bb/shared-ui/menu-item-hover";
import { blurActiveKeyboardInputWithin } from "@bb/shared-ui/overlay-trigger";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { cn } from "@bb/shared-ui/lib/utils";
import type { GitBranchRefClassification } from "@bb/domain";
import { searchPickerOptions } from "./picker-search";
import { useResetPickerScroll } from "./useResetPickerScroll";

interface GetMergeBaseBranchCandidatesArgs {
  mergeBaseBranch?: string;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions?: readonly string[];
  remoteMergeBaseBranchOptions?: readonly string[];
}

export interface MergeBaseBranchCandidateGroups {
  options: readonly string[];
  remoteOptions: readonly string[];
}

export function getMergeBaseBranchCandidateGroups({
  mergeBaseBranch,
  mergeBaseBranchRef,
  mergeBaseBranchOptions,
  remoteMergeBaseBranchOptions,
}: GetMergeBaseBranchCandidatesArgs): MergeBaseBranchCandidateGroups {
  const fromProps = mergeBaseBranchOptions ?? [];
  const fromRemoteProps = remoteMergeBaseBranchOptions ?? [];
  const selectedRef =
    mergeBaseBranchRef?.name === mergeBaseBranch ? mergeBaseBranchRef : null;
  const selectedOptionKind =
    selectedRef && selectedRef.kind !== "missing"
      ? selectedRef.kind
      : undefined;
  if (
    !mergeBaseBranch ||
    fromProps.includes(mergeBaseBranch) ||
    fromRemoteProps.includes(mergeBaseBranch)
  ) {
    return {
      options: fromProps,
      remoteOptions: fromRemoteProps,
    };
  }
  if (selectedOptionKind === "remote") {
    return {
      options: fromProps,
      remoteOptions: [mergeBaseBranch, ...fromRemoteProps],
    };
  }
  if (selectedOptionKind === "local" || selectedRef?.kind !== "missing") {
    return {
      options: [mergeBaseBranch, ...fromProps],
      remoteOptions: fromRemoteProps,
    };
  }
  return { options: fromProps, remoteOptions: fromRemoteProps };
}

const EMPTY_BRANCH_OPTIONS: readonly string[] = [];

interface BranchPickerTextProps {
  label: string;
  className?: string;
  wrap?: boolean;
}

interface OrderBranchPickerOptionsArgs {
  options: readonly string[];
  selectedValue: string | null;
}

function BranchPickerText({
  label,
  className,
  wrap = false,
}: BranchPickerTextProps) {
  return (
    <span
      className={cn(
        wrap ? "min-w-0 whitespace-normal break-words" : "min-w-0 truncate",
        className,
      )}
    >
      {label}
    </span>
  );
}

export function buildBranchPickerOptionGroups({
  options,
  remoteOptions,
}: {
  options: readonly string[];
  remoteOptions: readonly string[];
}): { local: string[]; remote: string[] } {
  const local = [...options];
  const localBranchNames = new Set(local);
  const remote = remoteOptions.filter(
    (branch) => !localBranchNames.has(branch),
  );
  return { local, remote };
}

export function orderBranchPickerOptions({
  options,
  selectedValue,
}: OrderBranchPickerOptionsArgs): string[] {
  const availableOptions = new Set(options);
  const ordered: string[] = [];
  const seenOptions = new Set<string>();

  const append = (branch: string | null | undefined) => {
    if (!branch || !availableOptions.has(branch) || seenOptions.has(branch)) {
      return;
    }
    ordered.push(branch);
    seenOptions.add(branch);
  };

  append(selectedValue);
  for (const branch of options) {
    append(branch);
  }

  return ordered;
}

export interface BranchPickerProps {
  value: string;
  options: readonly string[];
  remoteOptions?: readonly string[];
  loading?: boolean;
  onChange: (branch: string) => void;
  onSearchQueryChange?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  muted?: boolean;
  defaultOpen?: boolean;
  popoverAlign?: "start" | "end";
}

export function BranchPicker({
  value,
  options,
  remoteOptions = EMPTY_BRANCH_OPTIONS,
  loading = false,
  onChange,
  onSearchQueryChange,
  onOpenChange,
  className,
  muted,
  defaultOpen = false,
  popoverAlign = "start",
}: BranchPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const optionsScrollRef = useResetPickerScroll<HTMLDivElement>(query);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const branchOptionGroups = useMemo(
    () =>
      buildBranchPickerOptionGroups({
        options,
        remoteOptions,
      }),
    [options, remoteOptions],
  );
  const combinedBranchOptions = useMemo(
    () => [...branchOptionGroups.local, ...branchOptionGroups.remote],
    [branchOptionGroups.local, branchOptionGroups.remote],
  );
  const filteredCombinedBranchOptions = useMemo(
    () =>
      searchPickerOptions({
        options: combinedBranchOptions,
        query: deferredQuery,
        getLabel: (branch) => branch,
      }),
    [combinedBranchOptions, deferredQuery],
  );
  const filteredBranchOptions = useMemo(
    () =>
      orderBranchPickerOptions({
        options: filteredCombinedBranchOptions,
        selectedValue: isSearching ? null : value,
      }),
    [filteredCombinedBranchOptions, isSearching, value],
  );
  const firstFilteredOption = filteredBranchOptions[0];
  const enterSelection = value
    ? (filteredBranchOptions.find((branch) => branch === value) ??
      firstFilteredOption)
    : firstFilteredOption;
  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      blurActiveKeyboardInputWithin(inputRef.current);
    }
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const closePicker = () => {
    updateOpen(false);
  };
  const selectBranchAndClose = (branch: string) => {
    onChange(branch);
    closePicker();
  };

  useEffect(() => {
    if (!open) {
      setQuery("");
      onSearchQueryChange?.("");
      return;
    }

    onSearchQueryChange?.(normalizedQuery);
  }, [normalizedQuery, onSearchQueryChange, open]);

  return (
    <Popover modal open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Branch"
          className={cn(
            LIST_HOVER_TRANSITION,
            "-mx-1 h-5 w-auto min-w-0 justify-between gap-1 rounded-sm px-1 text-xs font-normal shadow-none hover:bg-state-hover data-[state=open]:bg-state-hover",
            muted && "text-muted-foreground hover:text-foreground",
            className,
          )}
          role="combobox"
          aria-expanded={open}
        >
          <span
            className="flex min-w-0 items-center overflow-hidden"
            title={value}
          >
            <BranchPickerText label={value} className="truncate text-left" />
          </span>
          <Icon
            name="ChevronDown"
            className="shrink-0 text-muted-foreground size-3"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={popoverAlign}
        sideOffset={6}
        collisionPadding={16}
        autoFocusRef={inputRef}
        className={cn(BRANCH_PICKER_CONTENT_CLASS_NAME, "md:min-w-40")}
      >
        <MenuHoverProvider>
          <BranchPickerSearch
            inputRef={inputRef}
            query={query}
            enterSelection={enterSelection}
            onEnterSelection={selectBranchAndClose}
            onQueryChange={setQuery}
          />
          <div
            ref={optionsScrollRef}
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:max-h-80"
            onWheel={(event) => {
              event.stopPropagation();
            }}
          >
            <BranchPickerSectionHeader label="Branches" />
            {filteredBranchOptions.map((branch) => (
              <BranchPickerRow
                key={branch}
                icon="GitMerge"
                selected={branch === value}
                title={branch}
                onSelect={() => selectBranchAndClose(branch)}
              >
                <BranchPickerText label={branch} className="flex-1" wrap />
              </BranchPickerRow>
            ))}
            {filteredBranchOptions.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {loading ? "Loading branches..." : "No branches found."}
              </p>
            ) : null}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}
