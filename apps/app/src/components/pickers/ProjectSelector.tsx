import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@bb/shared-ui/command";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { searchPickerOptions, useResetPickerScroll } from "./picker-search";

const PROJECT_SEARCH_MIN_OPTIONS = 5;
const NO_HIGHLIGHT_VALUE = "__project-picker-idle__";
const PROJECT_PICKER_ITEM_CLASS_NAME = "py-[0.3125rem] text-xs";

export interface ProjectSelectorCreateProjectConfig {
  onCreate: () => void;
  disabled?: boolean;
  isCreating?: boolean;
}

export function ProjectSelector({
  projects,
  value,
  onChange,
  createProject,
  disabled: disabledProp,
  isLoading,
}: {
  projects: readonly { id: string; name: string }[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  createProject: ProjectSelectorCreateProjectConfig;
  disabled: boolean;
  isLoading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedValue, setHighlightedValue] = useState(NO_HIGHLIGHT_VALUE);
  const commandRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  useLayoutEffect(() => {
    Array.from(
      commandRef.current?.querySelectorAll<HTMLElement>("[cmdk-item]") ?? [],
    )
      .find((item) => item.dataset.value === highlightedValue)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedValue]);
  const disabled = disabledProp || isLoading;
  const showSearch = projects.length > PROJECT_SEARCH_MIN_OPTIONS;
  const filteredProjects = showSearch
    ? searchPickerOptions({
        options: projects,
        query: searchQuery,
        getLabel: (project) => project.name,
      })
    : projects;
  const selected = projects.find((project) => project.id === value);
  const triggerLabel = isLoading
    ? "Loading projects…"
    : (selected?.name ?? (value === null ? "No project" : "Work in a project"));
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setHighlightedValue(NO_HIGHLIGHT_VALUE);
    if (!nextOpen) setSearchQuery("");
  };
  const selectProject = (projectId: string | null) => {
    onChange(projectId);
    handleOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Project: ${triggerLabel}`}
          aria-busy={isLoading || undefined}
          disabled={disabled}
          data-promptbox-project-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            !disabled && OPTION_INTERACTIVE_CLASS_NAME,
            disabled && "cursor-default disabled:opacity-100",
            OPTION_MUTED_CLASS_NAME,
            "shrink-0",
          )}
        >
          <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
            <Icon
              name={
                isLoading || selected
                  ? "Folder"
                  : value === null
                    ? "FolderMinus"
                    : "FolderPlus"
              }
              className="size-3.5 shrink-0"
              aria-hidden
            />
            <span className="min-w-0 truncate" data-promptbox-full-label="">
              {triggerLabel}
            </span>
            <span className="min-w-0 truncate" data-promptbox-compact-label="">
              {isLoading ? "Loading…" : (selected?.name ?? "No project")}
            </span>
          </span>
          <Icon
            name="ChevronDown"
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Project"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (showSearch ? searchInputRef : commandRef).current?.focus();
        }}
        className="flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] w-52 flex-col overflow-hidden p-0"
      >
        <Command
          ref={commandRef}
          label="Search projects"
          shouldFilter={false}
          value={highlightedValue}
          onValueChange={setHighlightedValue}
          className="min-h-0"
        >
          {showSearch ? (
            <CommandInput
              ref={searchInputRef}
              aria-label="Search projects"
              placeholder="Search projects"
              value={searchQuery}
              onValueChange={setSearchQuery}
              className="h-8 text-xs"
            />
          ) : null}
          <CommandList className="flex min-h-0 flex-1 flex-col overflow-hidden [&>[cmdk-list-sizer]]:flex [&>[cmdk-list-sizer]]:min-h-0 [&>[cmdk-list-sizer]]:flex-col">
            {projects.length > 0 ? (
              <CommandGroup
                heading="Project"
                className="flex min-h-0 flex-col [&>[cmdk-group-heading]]:shrink-0 [&>[cmdk-group-items]]:flex [&>[cmdk-group-items]]:min-h-0 [&>[cmdk-group-items]]:flex-col"
              >
                <div
                  ref={listRef}
                  className="min-h-0 overflow-y-auto overscroll-contain"
                >
                  {filteredProjects.map((project) => (
                    <CommandItem
                      key={project.id}
                      value={project.id}
                      keywords={[project.name]}
                      aria-current={project.id === value ? "true" : undefined}
                      onSelect={() => selectProject(project.id)}
                      className={PROJECT_PICKER_ITEM_CLASS_NAME}
                    >
                      <Icon
                        name="Folder"
                        className="size-4 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {project.name}
                      </span>
                      <Icon
                        name="Check"
                        className={cn(
                          "ml-auto size-4",
                          project.id === value ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden
                      />
                    </CommandItem>
                  ))}
                  {showSearch && filteredProjects.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No projects found
                    </div>
                  ) : null}
                </div>
              </CommandGroup>
            ) : null}
            <div className="shrink-0">
              {projects.length > 0 ? <CommandSeparator /> : null}
              <CommandGroup
                heading={projects.length === 0 ? "Project" : undefined}
              >
                <CommandItem
                  disabled={createProject.disabled}
                  value="new-project"
                  onSelect={() => {
                    createProject.onCreate();
                    handleOpenChange(false);
                  }}
                  className={PROJECT_PICKER_ITEM_CLASS_NAME}
                >
                  <Icon
                    name="FolderPlus"
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  {createProject.isCreating ? "Creating..." : "New project"}
                </CommandItem>
                <CommandItem
                  value="no-project"
                  aria-current={value === null ? "true" : undefined}
                  onSelect={() => selectProject(null)}
                  className={PROJECT_PICKER_ITEM_CLASS_NAME}
                >
                  <Icon
                    name="FolderMinus"
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  Don&apos;t work in a project
                  <Icon
                    name="Check"
                    className={cn(
                      "ml-auto size-4",
                      value === null ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                </CommandItem>
              </CommandGroup>
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
