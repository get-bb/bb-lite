import { fuzzyMatchText } from "@bb/fuzzy-match";
import {
  PERSONAL_PROJECT_ID,
  type AppCommandId,
  type ThreadListEntry,
} from "@bb/domain";
import type { PluginCommandContext } from "@bb/plugin/app";
import type {
  ThreadSearchMatch,
  ThreadSearchResponse,
} from "@bb/server-contract";
import type { PluginThreadPanelOpenHandler } from "@bb/app-kit/components/plugin/plugin-thread-panel-navigation";
import type { PluginSettingsEntry } from "@bb/app-kit/components/settings/plugin-settings-entries";
import {
  getSettingsSectionRoutePath,
  type SettingsNavSection,
} from "@bb/app-kit/components/settings/settings-sections";
import type { PluginSlot } from "@bb/app-kit/plugins/registry";
import { APP_COMMAND_GROUPS } from "@bb/app-kit/lib/app-command-metadata";
import type { AppShortcutPresentation } from "@bb/app-kit/lib/app-keybindings";
import { getPluginDisplayName } from "@bb/app-kit/lib/plugin-logos";
import { formatRelativeTime } from "@bb/app-kit/lib/relative-time";
import {
  getPluginConfigurationRoutePath,
  getPluginPanelRoutePath,
} from "@bb/app-kit/lib/route-paths";
import { getThreadDisplayTitle } from "@bb/app-kit/lib/thread-title";

export const PALETTE_ACTION_BUCKETS = [
  "Threads",
  "Actions",
  "Settings",
  "Plugins",
] as const;

export interface PaletteAction {
  id: string;
  bucket: (typeof PALETTE_ACTION_BUCKETS)[number];
  group: string;
  title: string;
  shortcut: AppShortcutPresentation | null;
  run: () => void;
}

export const PALETTE_COMMAND_IDS: readonly AppCommandId[] =
  APP_COMMAND_GROUPS.flatMap((group) =>
    group.commands
      .filter((metadata) => metadata.paletteVisible)
      .map((metadata) => metadata.command),
  );

export function paletteActionIdForCommand(command: AppCommandId): string {
  return `app:${command}`;
}

export function buildAppCommandActions(args: {
  target: EventTarget | null;
  isCommandAvailable: (
    command: AppCommandId,
    target: EventTarget | null,
  ) => boolean;
  dispatch: (command: AppCommandId, target: EventTarget | null) => void;
  shortcuts: ReadonlyMap<AppCommandId, AppShortcutPresentation>;
}): PaletteAction[] {
  return APP_COMMAND_GROUPS.flatMap((group) =>
    group.commands
      .filter(
        ({ command, paletteVisible }) =>
          paletteVisible && args.isCommandAvailable(command, args.target),
      )
      .map(({ command, label }) => ({
        id: paletteActionIdForCommand(command),
        bucket: group.label === "Threads" ? "Threads" : "Actions",
        group: group.label,
        title: label,
        shortcut: args.shortcuts.get(command) ?? null,
        run: () => args.dispatch(command, args.target),
      })),
  );
}

export function buildPluginPaletteActions(args: {
  slots: readonly PluginSlot<"commands">[];
  threadId: string | null;
  projectId: string | null;
  openThreadPanel: PluginThreadPanelOpenHandler | null;
}): PaletteAction[] {
  return args.slots.flatMap((slot): PaletteAction[] => {
    const name = `[plugin:${slot.pluginId}] commandPaletteAction "${slot.id}"`;
    const warn = (what: string, error: unknown) =>
      console.warn(
        `${name} ${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    const context: PluginCommandContext = {
      threadId: args.threadId,
      projectId: args.projectId,
      openPanel: (options) => {
        if (args.openThreadPanel !== null) {
          return args.openThreadPanel({ ...options, pluginId: slot.pluginId });
        }
        console.warn(
          `${name} openPanel declined: no thread side panel on this surface`,
        );
        return false;
      },
    };
    try {
      if (slot.isAvailable !== undefined && !slot.isAvailable(context)) {
        return [];
      }
    } catch (error) {
      warn("isAvailable failed", error);
      return [];
    }
    return [
      {
        id: `plugin:${slot.pluginId}/${slot.id}`,
        bucket: "Plugins",
        group: getPluginDisplayName(slot.pluginId),
        title: slot.title,
        shortcut: null,
        run: () => {
          try {
            const result = slot.run(context);
            if (result instanceof Promise) {
              result.catch((error: unknown) => warn("failed", error));
            }
          } catch (error) {
            warn("failed", error);
          }
        },
      },
    ];
  });
}

export function buildNavigationPaletteActions(args: {
  navigate: (path: string) => void;
  sections: readonly SettingsNavSection[];
  pluginEntries: readonly PluginSettingsEntry[];
  panels: readonly PluginSlot<"navPanels">[];
}): PaletteAction[] {
  const action = (
    bucket: PaletteAction["bucket"],
    group: string,
    id: string,
    title: string,
    path: string,
  ): PaletteAction => ({
    id,
    bucket,
    group,
    title,
    shortcut: null,
    run: () => args.navigate(path),
  });
  return [
    ...args.sections.map((section) =>
      action(
        "Settings",
        "Settings",
        `settings:${section.id}`,
        `${section.label} settings`,
        getSettingsSectionRoutePath(section.id),
      ),
    ),
    ...args.pluginEntries.map((plugin) =>
      action(
        "Settings",
        "Plugin settings",
        `settings:plugin:${plugin.id}`,
        `${plugin.label} settings`,
        getPluginConfigurationRoutePath({ pluginId: plugin.id }),
      ),
    ),
    ...args.panels.map(({ pluginId, id, path, title }) =>
      action(
        "Plugins",
        "Plugin pages",
        `plugin-page:${pluginId}/${id}`,
        title,
        getPluginPanelRoutePath({ pluginId, path }),
      ),
    ),
  ];
}

export interface RankedPaletteAction {
  action: PaletteAction;
  positions: readonly number[];
}

function titleMatchPositions(title: string, query: string): number[] {
  const positions: number[] = [];
  const haystack = title.toLowerCase();
  let cursor = 0;
  for (const character of query.toLowerCase()) {
    if (character === " ") continue;
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return [];
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

export function rankPaletteActions(args: {
  actions: readonly PaletteAction[];
  query: string;
  recentIds: readonly string[];
}): RankedPaletteAction[] {
  const { actions, query } = args;
  if (query.trim() === "") {
    return actions.map((action) => ({ action, positions: [] }));
  }
  const ids = actions.map((action) => action.id);
  const recentRank = (action: PaletteAction) => {
    const rank = args.recentIds.indexOf(action.id);
    return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
  };
  return fuzzyMatchText({
    items: actions,
    query,
    getText: (action) => action.title,
    getAliases: (action) => [action.group],
    limit: 50,
  })
    .sort(
      (left, right) =>
        right.score - left.score ||
        recentRank(left.item) - recentRank(right.item) ||
        ids.lastIndexOf(left.item.id) - ids.lastIndexOf(right.item.id),
    )
    .map((match) => ({
      action: match.item,
      positions: titleMatchPositions(match.item.title, query),
    }));
}

const PALETTE_RECENTS_KEY = "bb.palette.recents";
const PALETTE_RECENTS_LIMIT = 8;

export function readPaletteRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(PALETTE_RECENTS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, PALETTE_RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function recordPaletteRecent(
  recents: readonly string[],
  actionId: string,
): string[] {
  const next = [
    actionId,
    ...recents.filter((entry) => entry !== actionId),
  ].slice(0, PALETTE_RECENTS_LIMIT);
  try {
    window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

type HighlightRange = ThreadSearchMatch["highlightRanges"][number];

export interface PaletteThreadSearchRow {
  archived: boolean;
  primaryText: string;
  highlightRanges: readonly HighlightRange[];
  secondaryTitle: string | null;
  projectName: string | null;
  relativeTime: string;
  projectId: string;
  threadId: string;
  messageSeq: number | null;
}

export function buildPaletteThreadSearchRows(args: {
  now: number;
  projectNamesById: ReadonlyMap<string, string>;
  query: string;
  recentThreads: readonly ThreadListEntry[];
  searchResponse: ThreadSearchResponse | undefined;
  searchResultsAreCurrent: boolean;
}): PaletteThreadSearchRow[] {
  const { now } = args;
  const query = args.query.trim();
  const isTitleMatch = (match: ThreadSearchMatch) =>
    match.sourceKind === "title" || match.sourceKind === "title_fallback";
  const row = (
    thread: ThreadListEntry,
    matches: readonly ThreadSearchMatch[],
    archived: boolean,
  ): PaletteThreadSearchRow => {
    const title = getThreadDisplayTitle(thread);
    const snippet = matches.find((match) => !isTitleMatch(match));
    const primary =
      snippet ??
      matches.find((match) => isTitleMatch(match) && match.text === title);
    return {
      archived,
      primaryText: primary?.text ?? title,
      highlightRanges: primary?.highlightRanges ?? [],
      secondaryTitle: snippet === undefined ? null : title,
      projectName:
        thread.projectId === PERSONAL_PROJECT_ID
          ? null
          : (args.projectNamesById.get(thread.projectId) ?? null),
      relativeTime: formatRelativeTime({ timestamp: thread.updatedAt, now }),
      projectId: thread.projectId,
      threadId: thread.id,
      messageSeq: snippet?.sourceSeq ?? null,
    };
  };
  return [false, true].flatMap((archived) => {
    if (query.length === 0) {
      return args.recentThreads
        .filter((thread) => (thread.archivedAt !== null) === archived)
        .sort((left, right) =>
          archived
            ? (right.archivedAt ?? 0) - (left.archivedAt ?? 0)
            : right.updatedAt - left.updatedAt,
        )
        .slice(0, 20)
        .map((thread) => row(thread, [], archived));
    }
    const group = args.searchResponse?.[archived ? "archived" : "active"];
    return query.length >= 2 && args.searchResultsAreCurrent
      ? (group?.results ?? []).map((result) =>
          row(result.thread, result.matches, archived),
        )
      : [];
  });
}

const WINDOW_LEAD_CHARS = 16;
const WINDOW_TAIL_CHARS = 40;

function splitsSurrogatePair(text: string, index: number): boolean {
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function mergedHighlightRanges(
  text: string,
  ranges: readonly HighlightRange[],
): HighlightRange[] {
  const clamp = (value: number) =>
    Math.max(0, Math.min(Math.trunc(value), text.length));
  const merged: HighlightRange[] = [];
  for (const range of ranges
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end))
    .map(({ start, end }) => ({ start: clamp(start), end: clamp(end) }))
    .filter(({ start, end }) => end > start)
    .map(({ start, end }) => ({
      start: splitsSurrogatePair(text, start) ? start - 1 : start,
      end: splitsSurrogatePair(text, end) ? end + 1 : end,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else merged.push(range);
  }
  return merged;
}

export function windowPaletteThreadSearchText(args: {
  text: string;
  highlightRanges: readonly HighlightRange[];
}): { text: string; highlightRanges: HighlightRange[] } {
  const { text } = args;
  const ranges = mergedHighlightRanges(text, args.highlightRanges);
  const first = ranges[0];
  if (first === undefined) return { text, highlightRanges: [] };

  let start = Math.max(0, first.start - WINDOW_LEAD_CHARS);
  let end = Math.min(text.length, first.end + WINDOW_TAIL_CHARS);
  const leadingSpace = text.slice(start, first.start).search(/\s/u);
  if (start > 0 && leadingSpace !== -1) {
    start += leadingSpace + 1;
    while (start < first.start && /\s/u.test(text.charAt(start))) start += 1;
  }
  const trailingSpace = text.slice(first.end, end).search(/\s\S*$/u);
  if (end < text.length && trailingSpace > 0) end = first.end + trailingSpace;
  if (splitsSurrogatePair(text, start)) start += 1;
  if (splitsSurrogatePair(text, end)) end -= 1;

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    highlightRanges: ranges.flatMap((range) => {
      const rangeStart = Math.max(range.start, start);
      const rangeEnd = Math.min(range.end, end);
      return rangeEnd > rangeStart
        ? [
            {
              start: rangeStart - start + prefix.length,
              end: rangeEnd - start + prefix.length,
            },
          ]
        : [];
    }),
  };
}
