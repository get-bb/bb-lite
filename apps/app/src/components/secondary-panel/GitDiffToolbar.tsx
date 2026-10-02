import { useEffect, useRef, type Ref } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import {
  formatChangeSummary,
  renderChangeSummary,
} from "@/components/workspace/workspace-change-summary";
import {
  getNextCodeOverflowMode,
  type CodeOverflowMode,
  type CodeOverflowModeChangeHandler,
} from "@/lib/code-overflow-mode";
import { cn } from "@bb/shared-ui/lib/utils";
import type { GitDiffStats } from "../git-diff/git-diff-parsing";

const GIT_DIFF_SELECTOR_MENU_MIN_WIDTH = "20rem";

export type GitDiffDisplayMode = "unified" | "split";

export interface GitDiffSelectionOption {
  value: string;
  label: string;
  monoPrefix?: string;
}

interface GitDiffSelectorProps {
  value: string;
  options: readonly GitDiffSelectionOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  panelWidthPx: number;
}

function GitDiffSelector({
  value,
  options,
  onChange,
  disabled,
  panelWidthPx,
}: GitDiffSelectorProps) {
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;
  const selectedMonoPrefix = selectedOption?.monoPrefix;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-8 w-full min-w-0 justify-between gap-2 rounded-lg border border-border bg-transparent px-2.5 font-normal",
            "text-xs",
            disabled && "opacity-60",
          )}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            {selectedMonoPrefix ? (
              <span className="shrink-0 font-mono text-muted-foreground">
                {selectedMonoPrefix}
              </span>
            ) : null}
            <span className="truncate">{selectedLabel}</span>
          </span>
          <Icon
            name="ChevronDown"
            className={cn("size-3.5 shrink-0", "text-muted-foreground")}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
        style={{
          maxWidth: `min(var(--radix-popper-available-width), max(${GIT_DIFF_SELECTOR_MENU_MIN_WIDTH}, ${panelWidthPx}px))`,
        }}
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between gap-2"
          >
            <span
              className="flex min-w-0 items-baseline gap-2"
              title={
                option.monoPrefix
                  ? `${option.monoPrefix} ${option.label}`
                  : option.label
              }
            >
              {option.monoPrefix ? (
                <span className="shrink-0 font-mono text-muted-foreground">
                  {option.monoPrefix}
                </span>
              ) : null}
              <span className="truncate">{option.label}</span>
            </span>
            <Icon
              name="Check"
              className={cn(
                "size-3.5",
                option.value === value ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface GitDiffFileFilterInputProps {
  value: string;
  onChange: (value: string | null) => void;
}

function GitDiffFileFilterInput({
  value,
  onChange,
}: GitDiffFileFilterInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="relative mt-2">
      <span className="pointer-events-none absolute inset-y-0 left-2.25 flex w-8 items-center justify-center text-muted-foreground">
        <Icon name="Filter" className="size-3.5" />
      </span>
      <Input
        ref={inputRef}
        aria-label="Filter changed files by path"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-8 rounded-lg border-border pl-12 pr-8 text-xs focus-visible:ring-0"
        placeholder="Filter files, e.g. *.md, docs/**, !*.test.ts"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onChange(null);
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center text-muted-foreground hover:text-foreground"
          aria-label="Clear file filter"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <Icon name="X" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

interface GitDiffToolbarProps {
  rootRef: Ref<HTMLDivElement>;
  panelWidthPx: number;
  selectionValue: string;
  selectionOptions: readonly GitDiffSelectionOption[];
  onSelectionChange: (value: string) => void;
  isSelectorDisabled: boolean;
  stats: GitDiffStats;
  totalFilesCount: number;
  isTruncated: boolean;
  fileFilter: string | null;
  onFileFilterChange: (value: string | null) => void;
  areAllFilesCollapsed: boolean;
  isCollapseAllDisabled: boolean;
  onToggleAllCollapsed: () => void;
  displayMode: GitDiffDisplayMode;
  onDisplayModeChange: (mode: GitDiffDisplayMode) => void;
  lineOverflowMode: CodeOverflowMode;
  onLineOverflowModeChange: CodeOverflowModeChangeHandler;
}

export function GitDiffToolbar({
  rootRef,
  panelWidthPx,
  selectionValue,
  selectionOptions,
  onSelectionChange,
  isSelectorDisabled,
  stats,
  totalFilesCount,
  isTruncated,
  fileFilter,
  onFileFilterChange,
  areAllFilesCollapsed,
  isCollapseAllDisabled,
  onToggleAllCollapsed,
  displayMode,
  onDisplayModeChange,
  lineOverflowMode,
  onLineOverflowModeChange,
}: GitDiffToolbarProps) {
  const changeTally = { ...stats, lineStatsComplete: true };
  const completeSummary = formatChangeSummary(changeTally);
  const truncatedFilesLabel = `${stats.filesCount}+ file${stats.filesCount === 1 ? "" : "s"}`;
  const hasShownLineChanges = stats.insertions > 0 || stats.deletions > 0;
  const isFiltering = Boolean(fileFilter?.trim());
  const filteredFilesLabel = `${stats.filesCount} of ${totalFilesCount}${isTruncated ? "+" : ""} files`;
  const iconButton = (
    icon: IconName,
    label: string,
    onClick: () => void,
    pressed?: boolean,
    disabled?: boolean,
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 w-7 rounded-md p-0 [&_[data-icon-root]]:size-3.5",
        "text-muted-foreground",
      )}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
    >
      <Icon name={icon} />
    </Button>
  );

  return (
    <div ref={rootRef} className="px-4 pb-3 pt-3">
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="git-diff-toolbar-layout"
      >
        <div
          className="min-w-0 basis-48 grow-[999]"
          data-testid="git-diff-toolbar-selector-slot"
        >
          <GitDiffSelector
            value={selectionValue}
            options={selectionOptions}
            onChange={onSelectionChange}
            disabled={isSelectorDisabled}
            panelWidthPx={panelWidthPx}
          />
        </div>
        <div
          className="flex min-w-0 flex-1 basis-auto items-center gap-3"
          data-testid="git-diff-toolbar-details"
        >
          <span
            className={cn(
              "min-w-0 shrink truncate pl-2.5 text-muted-foreground",
              "text-xs",
            )}
            data-testid="git-diff-toolbar-summary"
            title={
              isFiltering
                ? `${stats.filesCount} of ${totalFilesCount}${isTruncated ? "+" : ""} changed files match the filter`
                : isTruncated
                  ? `Showing the first ${stats.filesCount} changed file${stats.filesCount === 1 ? "" : "s"}; shown slice: ${stats.insertions} insertion${stats.insertions === 1 ? "" : "s"}, ${stats.deletions} deletion${stats.deletions === 1 ? "" : "s"}`
                  : completeSummary
            }
          >
            {isFiltering ? (
              <>
                {filteredFilesLabel}
                {hasShownLineChanges ? (
                  <>
                    {" · "}
                    <DiffStatsTally
                      insertions={stats.insertions}
                      deletions={stats.deletions}
                    />
                  </>
                ) : null}
              </>
            ) : isTruncated ? (
              <>
                {truncatedFilesLabel}
                {hasShownLineChanges ? (
                  <>
                    {" · shown "}
                    <DiffStatsTally
                      insertions={stats.insertions}
                      deletions={stats.deletions}
                    />
                  </>
                ) : null}
              </>
            ) : (
              renderChangeSummary(changeTally)
            )}
          </span>
          <div
            className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1"
            data-testid="git-diff-toolbar-actions"
          >
            {iconButton(
              "Filter",
              fileFilter === null ? "Filter files" : "Close file filter",
              () => onFileFilterChange(fileFilter === null ? "" : null),
              fileFilter !== null,
            )}
            {iconButton(
              areAllFilesCollapsed ? "ChevronsDown" : "ChevronsUp",
              areAllFilesCollapsed ? "Expand all files" : "Collapse all files",
              onToggleAllCollapsed,
              undefined,
              isCollapseAllDisabled,
            )}
            {iconButton(
              "TextWrap",
              lineOverflowMode === "wrap"
                ? "Disable diff line wrap"
                : "Wrap diff lines",
              () =>
                onLineOverflowModeChange(
                  getNextCodeOverflowMode(lineOverflowMode),
                ),
              lineOverflowMode === "wrap",
            )}
            <div
              className="inline-flex items-center gap-1 rounded-lg border border-border p-0.5"
              role="tablist"
              aria-label="Diff view mode"
            >
              {iconButton(
                "Rows2",
                "Stacked diff view",
                () => onDisplayModeChange("unified"),
                displayMode === "unified",
              )}
              {iconButton(
                "Columns2",
                "Split diff view",
                () => onDisplayModeChange("split"),
                displayMode === "split",
              )}
            </div>
          </div>
        </div>
      </div>
      {fileFilter !== null ? (
        <GitDiffFileFilterInput
          value={fileFilter}
          onChange={onFileFilterChange}
        />
      ) : null}
    </div>
  );
}
