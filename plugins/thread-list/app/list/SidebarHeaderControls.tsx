import { createContext, useContext, type ReactNode } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { SidebarSectionId } from "@bb/client-core";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { SIDEBAR_CONTROL_BUTTON_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import {
  sidebarChronologicalSortAtom,
  sidebarEnvironmentGroupingAtom,
  sidebarGroupThreadsByEnvironmentAtom,
  sidebarShowProviderIconsAtom,
  sidebarSortDirectionAtom,
  sidebarThreadLifecyclesAtom,
} from "../preferences.js";
import {
  SidebarControlButton,
  SidebarRowControls,
} from "../rows/SidebarRowControls.js";

const SIDEBAR_SORT_OPTIONS = [
  { label: "Updated at", sort: "updated", direction: "descending" },
  { label: "Created at", sort: "created", direction: "descending" },
  { label: "Alphabetical", sort: "alpha", direction: "ascending" },
] as const;

const SIDEBAR_VIEW_PAGES = [
  { page: "organize", label: "Organize", icon: "Layers" },
  { page: "sort", label: "Sort by", icon: "ArrowUpDown" },
  { page: "filter", label: "Filter", icon: "SlidersHorizontal" },
] as const;

type SidebarViewPage = (typeof SIDEBAR_VIEW_PAGES)[number]["page"];

interface HeaderCreationActions {
  onNewSection?: (anchorSectionId?: SidebarSectionId) => void;
  isCreatingSection?: boolean;
}

const HeaderCreationContext = createContext<HeaderCreationActions>({});
export const SidebarHeaderActionsProvider = HeaderCreationContext.Provider;

function SidebarViewItems({ page }: { page: SidebarViewPage }) {
  const [lifecycles, setLifecycles] = useAtom(sidebarThreadLifecyclesAtom);
  const [sort, setSort] = useAtom(sidebarChronologicalSortAtom);
  const [savedDirection, setDirection] = useAtom(sidebarSortDirectionAtom);
  const setEnvironmentGrouping = useSetAtom(sidebarEnvironmentGroupingAtom);
  const groupByEnvironment = useAtomValue(sidebarGroupThreadsByEnvironmentAtom);
  const [showProviderIcons, setShowProviderIcons] = useAtom(
    sidebarShowProviderIconsAtom,
  );
  const selectedSort = sort === "none" ? "updated" : sort;
  if (page === "filter") {
    return (
      <DropdownMenuGroup aria-label="Filter">
        {(["active", "archived"] as const).map((lifecycle) => {
          const checked = lifecycles.includes(lifecycle);
          const required = checked && lifecycles.length === 1;
          return (
            <DropdownMenuItem
              key={lifecycle}
              role="menuitemcheckbox"
              aria-checked={checked}
              title={required ? "Keep at least one filter selected" : undefined}
              onSelect={(event) => {
                event.preventDefault();
                if (required) return;
                setLifecycles(
                  checked
                    ? lifecycles.filter((value) => value !== lifecycle)
                    : [...lifecycles, lifecycle],
                );
              }}
            >
              {lifecycle === "active" ? "Active" : "Archived"}
              <span className="ml-auto inline-flex size-4 items-center justify-center">
                {checked && <Icon name="Check" className="size-4" />}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuGroup>
    );
  }
  if (page === "organize") {
    return (
      <>
        <DropdownMenuGroup aria-label="Groups">
          <DropdownMenuLabel>Groups</DropdownMenuLabel>
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={groupByEnvironment}
            onSelect={(event) => {
              event.preventDefault();
              setEnvironmentGrouping(!groupByEnvironment);
            }}
          >
            By environment
            <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
              {groupByEnvironment && <Icon name="Check" className="size-4" />}
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup aria-label="Rows">
          <DropdownMenuLabel>Rows</DropdownMenuLabel>
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={showProviderIcons}
            onSelect={(event) => {
              event.preventDefault();
              setShowProviderIcons(!showProviderIcons);
            }}
          >
            Provider icons
            <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
              {showProviderIcons && <Icon name="Check" className="size-4" />}
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </>
    );
  }
  return (
    <DropdownMenuGroup aria-label="Sort">
      {SIDEBAR_SORT_OPTIONS.map((option) => {
        const selected = selectedSort === option.sort;
        const direction =
          savedDirection === "default" ? option.direction : savedDirection;
        const nextDirection = selected
          ? direction === "ascending"
            ? "descending"
            : "ascending"
          : option.direction;
        return (
          <DropdownMenuItem
            key={option.sort}
            role="menuitemradio"
            aria-checked={selected}
            aria-label={
              selected
                ? `${option.label}, ${direction}. Sort ${nextDirection}`
                : option.label
            }
            onSelect={(event) => {
              event.preventDefault();
              setSort(option.sort);
              setDirection(nextDirection);
            }}
          >
            {option.label}
            {selected && (
              <span className="sr-only">
                , {direction}. Sort {nextDirection}
              </span>
            )}
            <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
              {selected && (
                <Icon
                  name={direction === "ascending" ? "ArrowUp" : "ArrowDown"}
                  className="size-4"
                />
              )}
            </span>
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuGroup>
  );
}

export function SidebarHeaderControls({
  label,
  sectionId,
  onNewThread,
  children,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  label: string;
  sectionId: SidebarSectionId;
  onNewThread: () => void;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const creation = useContext(HeaderCreationContext);
  return (
    <SidebarRowControls
      primaryAction={
        <SidebarControlButton
          label={`New thread in ${label}`}
          icon="MessageSquarePlus"
          onClick={onNewThread}
        />
      }
    >
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${label} actions`}
            data-sidebar-rename-anchor=""
            className={SIDEBAR_CONTROL_BUTTON_CLASS}
          >
            <Icon name="MoreHorizontal" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
          <DropdownMenuItem
            disabled={!creation.onNewSection || creation.isCreatingSection}
            onSelect={() => creation.onNewSection?.(sectionId)}
          >
            <Icon name="SectionAdd" />
            New section
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {SIDEBAR_VIEW_PAGES.map((item) => (
            <DropdownMenuSub key={item.page}>
              <DropdownMenuSubTrigger>
                <Icon name={item.icon} />
                {item.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent
                  className={
                    item.page === "organize"
                      ? "min-w-32"
                      : "w-max min-w-28 max-w-64"
                  }
                >
                  <SidebarViewItems page={item.page} />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          ))}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarRowControls>
  );
}

export function SidebarSectionMenuItems({
  onRename,
  onRemove,
}: {
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onRename}>
        <Icon name="Edit" />
        Rename
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onRemove}>
        <Icon name="Trash2" />
        Remove
      </DropdownMenuItem>
    </>
  );
}
