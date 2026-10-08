import { lazy, Suspense, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  pluginCommandId,
  pluginCommandIdSchema,
  type KeyboardCommandId,
} from "@bb/domain";
import { Dialog, DialogContent, DialogTitle } from "@bb/shared-ui/dialog";
import { cn } from "@bb/shared-ui/lib/utils";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  useAppCommandHandler,
  useIndexedAppCommandHandlers,
  useAppCommandRunner,
  useAppCommandShortcuts,
} from "@bb/app-kit/components/commands/AppCommandProvider";
import {
  buildAppCommandActions,
  buildNavigationPaletteActions,
  buildPluginPaletteActions,
  PALETTE_ACTION_BUCKETS,
  PALETTE_COMMAND_IDS,
  paletteActionIdForCommand,
  rankPaletteActions,
  readPaletteRecents,
  recordPaletteRecent,
  type PaletteAction,
  type RankedPaletteAction,
} from "@bb/app-kit/lib/command-palette";
import { usePluginSlots } from "@bb/app-kit/plugins/registry";
import { getActiveThreadPanelOpener } from "@bb/app-kit/components/plugin/plugin-thread-panel-navigation";
import { pluginListQueryOptions } from "@bb/app-kit/hooks/queries/plugin-settings-queries";
import {
  buildPluginSettingsEntries,
  type PluginSettingsCandidate,
} from "@bb/app-kit/components/settings/plugin-settings-entries";
import { useSettingsPages } from "@bb/app-kit/components/settings/settings-sections";
import { appQueryClient } from "@bb/app-kit/lib/app-query-client";
import {
  PALETTE_SECTION_LABEL_CLASS,
  PaletteShell,
  PaletteShortcut,
} from "./PaletteShell";

const ThreadSearchPaletteMode = lazy(() =>
  import("./ThreadSearchPaletteMode").then((module) => ({
    default: module.ThreadSearchPaletteMode,
  })),
);

const THREAD_SEARCH_ACTION_ID = paletteActionIdForCommand("thread.search");

export function CommandPalette({
  threadId,
  projectId,
}: {
  threadId: string | null;
  projectId: string | null;
}) {
  const runner = useAppCommandRunner();
  const navigate = useNavigate();
  const shortcuts = useAppCommandShortcuts(PALETTE_COMMAND_IDS);
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [actions, setActions] = useState<readonly PaletteAction[]>([]);
  const [searchingThreads, setSearchingThreads] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<
    readonly PluginSettingsCandidate[]
  >([]);
  const [recents, setRecents] = useState<readonly string[]>(readPaletteRecents);
  const pluginSlots = usePluginSlots();
  const settingsPages = useSettingsPages();
  const pluginCommandIds = useMemo(
    () =>
      pluginSlots.commands.map((command) =>
        pluginCommandId(command.pluginId, command.id),
      ),
    [pluginSlots.commands],
  );
  const pluginShortcuts = useAppCommandShortcuts(pluginCommandIds);
  const pluginActions = (slots: typeof pluginSlots.commands) =>
    buildPluginPaletteActions({
      slots,
      threadId,
      projectId,
      openThreadPanel: getActiveThreadPanelOpener(),
    });
  useIndexedAppCommandHandlers(pluginCommandIds, (index) => {
    const slot = pluginSlots.commands[index];
    const action = slot && pluginActions([slot])[0];
    action?.run();
    return action !== undefined;
  });
  const openTargetRef = useRef<EventTarget | null>(null);
  const pendingRunRef = useRef<(() => void) | null>(null);
  const idPrefix = useId();

  const openPalette = (target: EventTarget | null, threads: boolean) => {
    if (!open) openTargetRef.current = target ?? document.activeElement;
    const openTarget = openTargetRef.current;
    setActions([
      ...buildAppCommandActions({
        target: openTarget,
        isCommandAvailable: runner.isCommandAvailable,
        dispatch: runner.dispatch,
        shortcuts,
      }),
      ...pluginActions(pluginSlots.commands).map((action) => ({
        ...action,
        shortcut:
          pluginShortcuts.get(pluginCommandIdSchema.parse(action.id)) ?? null,
      })),
    ]);
    setQuery("");
    setHighlightedIndex(0);
    setOpenCount((count) => count + 1);
    setSearchingThreads(threads);
    setOpen(true);
    void appQueryClient
      .fetchQuery(pluginListQueryOptions({ enabled: true }))
      .then(setInstalledPlugins, () => {});
    return true;
  };
  useAppCommandHandler("palette.open", ({ target }) =>
    openPalette(target, false),
  );
  useAppCommandHandler(
    "thread.search",
    ({ target }) => openPalette(target, true),
    100,
  );

  const chooseAction = (action: PaletteAction) => {
    setRecents((current) => recordPaletteRecent(current, action.id));
    if (action.id === THREAD_SEARCH_ACTION_ID) return action.run();
    pendingRunRef.current = action.run;
    setOpen(false);
  };
  const exitMode = () => {
    setSearchingThreads(false);
    setQuery("");
    setHighlightedIndex(0);
  };

  const goTo = (path: string) => void navigate(path);
  const commandQuery = query.startsWith(">") ? query.slice(1) : query;
  const ranked = rankPaletteActions({
    actions: [
      ...actions,
      ...buildNavigationPaletteActions({
        navigate: goTo,
        pluginEntries: buildPluginSettingsEntries({
          installedPlugins,
          settingsSections: pluginSlots.settingsSections,
        }),
        sections: settingsPages,
        panels: pluginSlots.navPanels,
      }),
    ],
    query: commandQuery,
    recentIds: recents,
  });
  const isGrouped = commandQuery.trim() === "";
  const groups = isGrouped
    ? PALETTE_ACTION_BUCKETS.map((bucket) => ({
        bucket,
        entries: ranked.filter((entry) => entry.action.bucket === bucket),
      })).filter((group) => group.entries.length > 0)
    : [{ bucket: null, entries: ranked }];
  const entries = groups.flatMap((group) => group.entries);
  const activeIndex = Math.min(highlightedIndex, entries.length - 1);
  const isCompactViewport = useIsCompactViewport();
  const renderRow = (entry: RankedPaletteAction) => {
    const index = entries.indexOf(entry);
    const { action } = entry;
    const isDrillIn = action.id === THREAD_SEARCH_ACTION_ID;
    const group = action.id.startsWith("plugin:") ? action.group : null;
    const shortcut = isCompactViewport ? null : action.shortcut;
    const emphasized = new Set(entry.positions);
    return (
      <div
        key={action.id}
        id={`${idPrefix}-${index}`}
        role="option"
        aria-selected={index === activeIndex}
        data-palette-action-kind={isDrillIn ? "drill-in" : "terminal"}
        className={cn(
          "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none",
          index === activeIndex && "bg-state-hover text-foreground",
        )}
        onPointerMove={() => setHighlightedIndex(index)}
        onClick={() => chooseAction(action)}
      >
        <span className="min-w-0 truncate">
          {emphasized.size === 0
            ? `${action.title}${isDrillIn ? "…" : ""}`
            : [...`${action.title}${isDrillIn ? "…" : ""}`].map(
                (character, position) => (
                  <span
                    key={position}
                    className={
                      emphasized.has(position)
                        ? "font-semibold text-foreground"
                        : undefined
                    }
                  >
                    {character}
                  </span>
                ),
              )}
        </span>
        {group !== null || shortcut !== null || isDrillIn ? (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {group === null ? null : (
              <span className="text-xs text-muted-foreground">{group}</span>
            )}
            {shortcut === null ? null : (
              <PaletteShortcut>{shortcut.label}</PaletteShortcut>
            )}
            {isDrillIn ? (
              <span className="sr-only">Opens a search view</span>
            ) : null}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (details?.reason === "escape-key" && searchingThreads) {
          details.cancel();
        } else setOpen(nextOpen);
        if (!nextOpen) exitMode();
      }}
    >
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className="top-[12%] max-w-[640px] translate-y-0 gap-0 p-0 shadow-lg sm:rounded-xl"
        onAfterCloseAutoFocus={() => {
          const pending = pendingRunRef.current;
          pendingRunRef.current = null;
          const target = openTargetRef.current;
          if (target instanceof HTMLElement && target.isConnected) {
            target.focus({ preventScroll: true });
          }
          pending?.();
        }}
        onKeyDownCapture={(event) => {
          if (
            !open ||
            !(event.target instanceof Node) ||
            !event.currentTarget.contains(event.target)
          ) {
            return;
          }
          const byCommand = new Map<KeyboardCommandId, PaletteAction>();
          for (const action of actions) {
            const command = [...PALETTE_COMMAND_IDS, ...pluginCommandIds].find(
              (candidate) =>
                action.id === candidate || action.id === `app:${candidate}`,
            );
            if (command) byCommand.set(command, action);
          }
          const command = runner.getShortcutCommand(event.nativeEvent, [
            "palette.open",
            ...byCommand.keys(),
          ]);
          if (command === null) return;
          event.preventDefault();
          event.stopPropagation();
          const action = byCommand.get(command);
          if (command === "palette.open") {
            runner.dispatch(command, openTargetRef.current);
          } else if (action) chooseAction(action);
        }}
        data-testid="command-palette"
      >
        <DialogTitle className="sr-only">Quick palette</DialogTitle>
        {!searchingThreads ? (
          <PaletteShell
            key={openCount}
            activeIndex={activeIndex}
            idPrefix={idPrefix}
            inputDescription="Use Escape to close the command palette."
            inputLabel="Search commands"
            listLabel="Commands"
            onActiveIndexChange={setHighlightedIndex}
            onChoose={(index) => {
              const entry = entries[index];
              if (entry) chooseAction(entry.action);
            }}
            onInputChange={(value) => {
              setQuery(value);
              setHighlightedIndex(0);
            }}
            optionCount={entries.length}
            placeholder="Search commands…"
            value={query}
          >
            {entries.length === 0 && !isGrouped ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                No matching commands
              </p>
            ) : (
              groups.map(({ bucket, entries: groupEntries }) =>
                bucket === null ? (
                  groupEntries.map(renderRow)
                ) : (
                  <div
                    key={bucket}
                    role="group"
                    aria-labelledby={`${idPrefix}-${bucket.toLowerCase()}-label`}
                    data-palette-bucket={bucket}
                  >
                    <div
                      id={`${idPrefix}-${bucket.toLowerCase()}-label`}
                      className={PALETTE_SECTION_LABEL_CLASS}
                    >
                      {bucket}
                    </div>
                    {groupEntries.map(renderRow)}
                  </div>
                ),
              )
            )}
          </PaletteShell>
        ) : (
          <Suspense
            fallback={
              <p
                role="status"
                className="px-3 py-4 text-sm text-muted-foreground"
              >
                Loading threads
              </p>
            }
          >
            <ThreadSearchPaletteMode
              onExit={exitMode}
              runAfterClose={(run) => {
                pendingRunRef.current = run;
                setOpen(false);
              }}
            />
          </Suspense>
        )}
      </DialogContent>
    </Dialog>
  );
}
