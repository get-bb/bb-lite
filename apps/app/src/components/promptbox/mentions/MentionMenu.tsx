import { useEffect, useRef, type ReactNode } from "react";
import {
  providerCommandSection,
  type ProviderCommandSection,
} from "@bb/server-contract";
import { directoryFromPath } from "@bb/thread-view";
import { promptMentionResourceFromSuggestion } from "@/components/promptbox/editor/prompt-editor-serialization";
import { promptCommandIconName } from "@/components/promptbox/mentions/prompt-mention-display";
import { PromptMentionIcon } from "@/components/promptbox/mentions/PromptMentionIcon";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { Icon } from "@bb/shared-ui/icon";
import { Pill } from "@bb/shared-ui/pill";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";
import type {
  PromptMentionSuggestion,
  ProviderCommandSuggestion,
  TypeaheadMenuState,
} from "@bb/client-core";

export type TypeaheadSuggestion =
  | PromptMentionSuggestion
  | ProviderCommandSuggestion;

type ApplySuggestion = (item: TypeaheadSuggestion) => void;

const ROW_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";
const MUTED_TRAILING_CLASS = "text-subtle-foreground [flex-shrink:9999]";

const commandSectionLabel = (kind: ProviderCommandSection) =>
  kind === "agent-command"
    ? "Commands"
    : kind === "skill"
      ? "Skills"
      : kind === "project-command"
        ? "Project commands"
        : "User commands";

function mentionTitle(item: PromptMentionSuggestion): string {
  switch (item.kind) {
    case "thread":
      return [
        item.title || item.path,
        item.projectName,
        item.relation?.replace("-", " "),
      ]
        .filter((part) => part !== undefined && part !== null)
        .join(" · ");
    case "project":
      return `Project: ${item.name}`;
    case "section":
      return `Section: ${item.name}`;
    case "plugin":
      return `${item.providerLabel}: ${item.title}`;
    case "path":
      return `${item.source === "thread-storage" ? "Thread storage" : "Workspace"}: ${item.path}`;
  }
}

export function typeaheadSuggestionKey(item: TypeaheadSuggestion): string {
  return JSON.stringify(
    item.kind === "command"
      ? [item.kind, item.source, item.origin, item.pluginId ?? null, item.name]
      : item.kind === "path"
        ? [item.kind, item.source, item.entryKind, item.path]
        : item.kind === "plugin"
          ? [item.kind, item.pluginId, item.providerId, item.itemId]
          : item.kind === "thread"
            ? [item.kind, item.threadId]
            : item.kind === "project"
              ? [item.kind, item.projectId]
              : [item.kind, item.sectionId],
  );
}

interface SuggestionRowProps {
  isSelected: boolean;
  icon: ReactNode;
  primary: ReactNode;
  trailing: ReactNode;
  badge?: ReactNode;
  title: string;
  onApply: () => void;
}

function SuggestionRow({
  isSelected,
  icon,
  primary,
  trailing,
  badge,
  title,
  onApply,
}: SuggestionRowProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isSelected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isSelected]);
  return (
    <button
      ref={ref}
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        onApply();
      }}
      className={cn(
        "w-full scroll-mt-7 rounded px-2 py-1.5 text-left text-xs",
        isSelected ? "bg-state-active text-foreground" : "hover:bg-state-hover",
      )}
      title={title}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        {typeof primary === "string" ? (
          <span className="truncate text-foreground">{primary}</span>
        ) : (
          primary
        )}
        {trailing}
        {badge ? <span className="ml-auto shrink-0">{badge}</span> : null}
      </div>
    </button>
  );
}

function ThreadSuggestionRow({
  item,
  ...rowProps
}: Omit<SuggestionRowProps, "primary" | "title" | "badge"> & {
  item: Extract<PromptMentionSuggestion, { kind: "thread" }>;
}) {
  const threadTitle = item.title || "Untitled thread";
  const displayTitle = useThreadTitleDisplayText(threadTitle);
  const relation = item.relation?.replace("-", " ");
  return (
    <SuggestionRow
      {...rowProps}
      primary={<ThreadTitle title={threadTitle} className="text-foreground" />}
      title={mentionTitle({ ...item, title: displayTitle })}
      badge={
        relation === undefined ? undefined : (
          <Pill variant="secondary" size="sm">
            {item.relation === "same-environment" ? (
              <>
                <span className="@max-[26rem]/mention-menu:hidden">
                  {relation}
                </span>
                <span className="hidden @max-[26rem]/mention-menu:inline">
                  same env
                </span>
              </>
            ) : (
              relation
            )}
          </Pill>
        )
      }
    />
  );
}

function MenuStatusRow({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <div className={cn("text-xs", "px-3 py-2", className)}>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

function MenuSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 bg-background text-xs text-muted-foreground px-3 pb-1 pt-1.5">
        <span>{label}</span>
      </div>
      <div className="flex flex-col gap-px px-1">{children}</div>
    </div>
  );
}

function MentionRow({
  item,
  isSelected,
  onApply,
}: {
  item: PromptMentionSuggestion;
  isSelected: boolean;
  onApply: ApplySuggestion;
}) {
  const directory = item.kind === "path" ? directoryFromPath(item.path) : "";
  const secondary =
    item.kind === "thread"
      ? item.projectName
      : item.kind === "plugin"
        ? item.subtitle
        : null;
  const rowProps = {
    isSelected,
    icon: (
      <PromptMentionIcon
        resource={promptMentionResourceFromSuggestion(item)}
        className={ROW_ICON_CLASS}
      />
    ),
    trailing: directory ? (
      <TruncateStart className={MUTED_TRAILING_CLASS}>
        {directory}
      </TruncateStart>
    ) : secondary != null ? (
      <span className={cn("truncate", MUTED_TRAILING_CLASS)}>{secondary}</span>
    ) : null,
    onApply: () => onApply(item),
  };
  return item.kind === "thread" ? (
    <ThreadSuggestionRow {...rowProps} item={item} />
  ) : (
    <SuggestionRow
      {...rowProps}
      primary={item.kind === "plugin" ? item.title : item.name}
      title={mentionTitle(item)}
    />
  );
}

function CommandRow({
  item,
  isSelected,
  onApply,
}: {
  item: ProviderCommandSuggestion;
  isSelected: boolean;
  onApply: ApplySuggestion;
}) {
  return (
    <SuggestionRow
      isSelected={isSelected}
      icon={
        item.pluginId !== undefined ? (
          <PluginIcon
            pluginId={item.pluginId}
            icon={null}
            className={ROW_ICON_CLASS}
          />
        ) : (
          <Icon
            name={promptCommandIconName(item)}
            className={ROW_ICON_CLASS}
            aria-hidden
          />
        )
      }
      primary={item.name}
      trailing={
        <>
          {item.description !== null ? (
            <span className={cn("truncate", MUTED_TRAILING_CLASS)}>
              {item.description}
            </span>
          ) : null}
          {item.kind === "command" && item.argumentHint !== null ? (
            <span className="shrink-0 text-subtle-foreground">
              {item.argumentHint}
            </span>
          ) : null}
        </>
      }
      title={item.description ?? item.name}
      onApply={() => onApply(item)}
    />
  );
}

export function MentionMenu({
  state,
  selectedIndex,
  onApply,
}: {
  state: TypeaheadMenuState;
  selectedIndex: number;
  onApply: ApplySuggestion;
}) {
  const isCommand = state.trigger === "command";
  const commands =
    state.trigger === "command" && state.state.kind === "results"
      ? state.state.suggestions
      : [];
  const commandSections = [
    ...new Set(commands.map(providerCommandSection)),
  ].map((kind) => ({
    kind,
    items: commands
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => providerCommandSection(item) === kind),
  }));
  const mentionGroups =
    state.trigger === "mention" && state.state.kind === "results"
      ? state.state.results.groups
      : [];

  return (
    <div className="@container/mention-menu overflow-hidden rounded-md border border-border bg-popover text-popover-foreground">
      <div className="max-h-48 overflow-y-auto">
        {state.state.kind === "hint" ? (
          <MenuStatusRow className="text-muted-foreground">
            Type to search mentions
          </MenuStatusRow>
        ) : state.state.kind === "loading" ? (
          <MenuStatusRow className="text-muted-foreground">
            <Icon name="Spinner" className="size-3.5 animate-spin" />
            <span>
              {isCommand ? "Searching commands…" : "Searching mentions…"}
            </span>
          </MenuStatusRow>
        ) : state.state.kind === "error" ? (
          <MenuStatusRow className="text-destructive">
            {isCommand
              ? "Failed to load commands"
              : "Failed to load suggestions"}
          </MenuStatusRow>
        ) : isCommand ? (
          commandSections.length === 0 ? null : (
            <div className="pb-1">
              {commandSections.map((section) => (
                <MenuSection
                  key={section.kind}
                  label={commandSectionLabel(section.kind)}
                >
                  {section.items.map(({ item, index }) => (
                    <CommandRow
                      key={typeaheadSuggestionKey(item)}
                      item={item}
                      isSelected={index === selectedIndex}
                      onApply={onApply}
                    />
                  ))}
                </MenuSection>
              ))}
            </div>
          )
        ) : mentionGroups.length === 0 ? (
          <MenuStatusRow className="text-muted-foreground">
            No matching mentions
          </MenuStatusRow>
        ) : (
          <div className="pb-1">
            {mentionGroups.map((group) => (
              <MenuSection key={group.key} label={group.label}>
                {group.suggestions.map((item, itemIndex) => (
                  <MentionRow
                    key={typeaheadSuggestionKey(item)}
                    item={item}
                    isSelected={group.startIndex + itemIndex === selectedIndex}
                    onApply={onApply}
                  />
                ))}
              </MenuSection>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
