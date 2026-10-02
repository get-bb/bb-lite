import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { directoryFromPath } from "@bb/thread-view";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import type { PluginPanelActionEntry } from "@/components/plugin/PluginPanelActions";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { usePathSuggestions } from "@/hooks/usePathSuggestions";
import { resolveRightPanelFileIconName } from "./RightPanelFileTabIcon";

interface NewTabPageProps {
  autoFocus: boolean;
  projectId: string | undefined;
  environmentId: string | null;
  onAutoFocusHandled: () => void;
  onSelect: (path: string) => void;
  onStartTerminal?: () => void;
  pluginActions?: readonly PluginPanelActionEntry[];
}

const FILE_SEARCH_LIMIT = 20;
const ROW_ICON_CLASS = `flex shrink-0 items-center justify-center overflow-hidden text-muted-foreground size-4`;

function SectionHeader({ label, sticky }: { label: string; sticky?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 px-2 pb-2",
        CHROME_SECTION_LABEL_CLASS,
        sticky ? "sticky top-0 z-10 bg-sidebar" : "pb-1",
      )}
    >
      <span>{label}</span>
    </div>
  );
}

function SearchMessage({
  iconName,
  message,
}: {
  iconName: IconName;
  message: string;
}) {
  return (
    <EmptyStatePanel className="flex min-h-24 items-center justify-center">
      <div className="flex max-w-64 items-center justify-center gap-1.5">
        <Icon
          name={iconName}
          className={cn(
            "size-4",
            "shrink-0",
            iconName === "Spinner" && "animate-spin",
          )}
        />
        <p className="text-xs">{message}</p>
      </div>
    </EmptyStatePanel>
  );
}

export function NewTabPage({
  autoFocus,
  projectId,
  environmentId,
  onAutoFocusHandled,
  onSelect,
  onStartTerminal,
  pluginActions = [],
}: NewTabPageProps) {
  const quickOpenShortcut = useAppCommandShortcut("file.quickOpen");
  const terminalShortcut = useAppCommandShortcut("terminal.open");
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const hasQuery = query.trim().length > 0;
  const search = usePathSuggestions({
    projectId,
    query,
    limit: FILE_SEARCH_LIMIT,
    environmentId,
    includeDirectories: false,
  });
  const suggestions = hasQuery
    ? search.suggestions.filter((item) => item.entryKind === "file")
    : [];
  const isUnavailable = !projectId;
  const activeSuggestion = suggestions[activeIndex];
  const suggestionId = (path: string) =>
    `file-search-result-workspace-${encodeURIComponent(path)}`;

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
    onAutoFocusHandled();
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, onAutoFocusHandled]);
  useEffect(() => {
    setActiveIndex(0);
  }, [query, suggestions.length]);

  const actions: {
    id: string;
    icon: ReactNode;
    label: string;
    shortcut: typeof terminalShortcut;
    onSelect: () => void;
  }[] = [
    ...(onStartTerminal === undefined
      ? []
      : [
          {
            id: "file-search-result-start-terminal",
            icon: <Icon name="Terminal" className="size-3.5" aria-hidden />,
            label: "Start terminal",
            shortcut: terminalShortcut,
            onSelect: onStartTerminal,
          },
        ]),
    ...pluginActions.map((action) => ({
      id: action.id,
      icon: (
        <PluginItemIcon
          pluginId={action.pluginId}
          icon={action.icon}
          className="size-3.5"
        />
      ),
      label: action.title,
      shortcut: null,
      onSelect: action.onSelect,
    })),
  ];
  const idleActions =
    actions.length === 0 ? null : (
      <div data-testid="new-tab-actions" className="flex min-w-0 flex-col">
        <section>
          <SectionHeader label="Actions" />
          <div className="flex flex-col gap-px">
            {actions.map((action) => (
              <div
                key={action.id}
                className={cn(
                  `group flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-left ${LIST_HOVER_TRANSITION} focus-visible:outline-none text-xs focus-visible:bg-state-hover focus-visible:text-foreground`,
                  "relative scroll-mt-7 focus-within:bg-state-hover focus-within:text-foreground",
                  "hover:bg-state-hover",
                )}
              >
                <button
                  type="button"
                  id={action.id}
                  data-panel-new-tab-item=""
                  aria-keyshortcuts={action.shortcut?.ariaKeyshortcuts}
                  onClick={action.onSelect}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none disabled:cursor-default"
                >
                  <span className={ROW_ICON_CLASS}>{action.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {action.label}
                  </span>
                </button>
                <AppCommandShortcutHint shortcut={action.shortcut} />
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  const showLoading = search.isLoading && suggestions.length === 0;

  return (
    <div
      data-panel-new-tab-page=""
      className="flex min-h-full flex-col gap-3 bg-sidebar px-4 pb-3 pt-1"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="relative min-w-0">
          <Icon
            name="Search"
            className={cn(
              "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground",
              "size-4",
            )}
          />
          <Input
            ref={inputRef}
            data-panel-new-tab-item=""
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (suggestions.length === 0) return;
              const step =
                event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowUp"
                    ? -1
                    : 0;
              if (step !== 0) {
                event.preventDefault();
                setActiveIndex(
                  (current) =>
                    (current + step + suggestions.length) % suggestions.length,
                );
              } else if (event.key === "Enter" && activeSuggestion) {
                event.preventDefault();
                onSelect(activeSuggestion.path);
              }
            }}
            disabled={isUnavailable}
            role="combobox"
            aria-label={
              quickOpenShortcut
                ? `Search files (${quickOpenShortcut.label})`
                : "Search files"
            }
            aria-keyshortcuts={quickOpenShortcut?.ariaKeyshortcuts}
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? listboxId : undefined}
            aria-activedescendant={
              activeSuggestion ? suggestionId(activeSuggestion.path) : undefined
            }
            placeholder={
              isUnavailable ? "No searchable source" : "Search files"
            }
            className={cn("h-8 pl-8 pr-8 focus-visible:ring-0", "text-xs")}
          />
          {search.isDebouncing ? (
            <Icon
              name="Spinner"
              className={cn(
                "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground",
                "size-3.5",
              )}
            />
          ) : null}
        </div>
        {hasQuery ? null : idleActions}
        {isUnavailable ? (
          <SearchMessage
            iconName="FileQuestion"
            message="No searchable source is available."
          />
        ) : !hasQuery ? null : suggestions.length === 0 ? (
          <div className="pb-1">
            <SearchMessage
              iconName={
                showLoading
                  ? "Spinner"
                  : search.isError
                    ? "AlertCircle"
                    : "FileQuestion"
              }
              message={
                showLoading
                  ? "Searching files..."
                  : search.isError
                    ? "Search failed."
                    : "No results match your search."
              }
            />
          </div>
        ) : (
          <div className="pb-1">
            <div id={listboxId} role="listbox" aria-label="File search results">
              <section role="group" aria-label="Files">
                <SectionHeader label="Files" sticky />
                <div className="flex flex-col gap-px">
                  {suggestions.map((suggestion, index) => {
                    const directory = directoryFromPath(suggestion.path);
                    return (
                      <button
                        key={suggestion.path}
                        type="button"
                        id={suggestionId(suggestion.path)}
                        data-panel-new-tab-item=""
                        role="option"
                        aria-selected={index === activeIndex}
                        onClick={() => onSelect(suggestion.path)}
                        onMouseEnter={() => setActiveIndex(index)}
                        onFocus={() => setActiveIndex(index)}
                        title={`Workspace: ${suggestion.path}`}
                        className={cn(
                          "w-full scroll-mt-7 rounded px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          LIST_HOVER_TRANSITION,
                          "text-xs",
                          index === activeIndex
                            ? "bg-state-active"
                            : "hover:bg-state-hover",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Icon
                            name={resolveRightPanelFileIconName(
                              suggestion.path,
                            )}
                            className={cn(
                              "size-3.5 shrink-0",
                              "text-muted-foreground",
                            )}
                            aria-hidden
                          />
                          <span className="truncate">{suggestion.name}</span>
                          {directory ? (
                            <TruncateStart className="text-muted-foreground [flex-shrink:9999]">
                              {directory}
                            </TruncateStart>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
