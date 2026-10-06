import { useDeferredValue, useEffect, useRef, useState } from "react";
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
import { searchPickerOptions, useResetPickerScroll } from "./picker-search";

export function getMergeBaseBranchCandidateGroups({
  mergeBaseBranch,
  mergeBaseBranchRef,
  mergeBaseBranchOptions: options = [],
  remoteMergeBaseBranchOptions: remoteOptions = [],
}: {
  mergeBaseBranch?: string;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions?: readonly string[];
  remoteMergeBaseBranchOptions?: readonly string[];
}): { options: readonly string[]; remoteOptions: readonly string[] } {
  const kind =
    mergeBaseBranchRef?.name === mergeBaseBranch
      ? mergeBaseBranchRef?.kind
      : undefined;
  if (
    !mergeBaseBranch ||
    kind === "missing" ||
    options.includes(mergeBaseBranch) ||
    remoteOptions.includes(mergeBaseBranch)
  ) {
    return { options, remoteOptions };
  }
  return kind === "remote"
    ? { options, remoteOptions: [mergeBaseBranch, ...remoteOptions] }
    : { options: [mergeBaseBranch, ...options], remoteOptions };
}

const EMPTY_BRANCH_OPTIONS: readonly string[] = [];

interface BranchPickerProps {
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
  const filteredOptions = searchPickerOptions({
    options: [
      ...options,
      ...remoteOptions.filter((branch) => !options.includes(branch)),
    ],
    query: deferredQuery,
    getLabel: (branch) => branch,
  });
  const filteredBranchOptions = [
    ...new Set(
      normalizedQuery.length === 0 && filteredOptions.includes(value)
        ? [value, ...filteredOptions]
        : filteredOptions,
    ),
  ];
  const enterSelection =
    (value ? filteredBranchOptions.find((branch) => branch === value) : null) ??
    filteredBranchOptions[0];
  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      blurActiveKeyboardInputWithin(inputRef.current);
    }
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const selectBranchAndClose = (branch: string) => {
    onChange(branch);
    updateOpen(false);
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
            <span className="min-w-0 truncate text-left">{value}</span>
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
        mobileTitle="Branch"
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
            onWheel={(event) => event.stopPropagation()}
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
                <span className="min-w-0 whitespace-normal break-words flex-1">
                  {branch}
                </span>
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
