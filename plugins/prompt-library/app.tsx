import {
  useEffect,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import {
  composer,
  Icon,
  shell,
  useCall,
  useOp,
  usePluginId,
  type ComposerHandle,
  type PluginAppApi,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import {
  promptLibrary,
  promptScopeSchema,
  type ComposerKind,
  type PromptRow,
  type PromptScope,
  type PromptSnippet,
} from "./contract";

type Target = { composerKey: string | null; threadId: string | null } | null;

let openTarget: Target = null;
const listeners = new Set<() => void>();

function setTarget(next: Target): void {
  openTarget = next;
  for (const listener of listeners) listener();
}

function useTarget(): Target {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => openTarget,
  );
}

function scopesFor(kind: ComposerKind): PromptScope[] {
  return kind === "new-thread"
    ? ["project", "global"]
    : ["thread", "project", "global"];
}

const SCOPE_LABELS: Record<PromptScope, string> = {
  thread: "Thread",
  project: "Project",
  global: "All",
};

function storedScope(key: string, kind: ComposerKind): PromptScope {
  const stored = promptScopeSchema.safeParse(window.localStorage.getItem(key));
  return stored.success && scopesFor(kind).includes(stored.data)
    ? stored.data
    : scopesFor(kind)[0]!;
}

function Highlighted({ snippet }: { snippet: PromptSnippet }) {
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [from, to] of snippet.highlights) {
    if (from > at)
      parts.push({ text: snippet.text.slice(at, from), mark: false });
    parts.push({ text: snippet.text.slice(from, to), mark: true });
    at = to;
  }
  parts.push({ text: snippet.text.slice(at), mark: false });
  return (
    <span className="truncate">
      {parts.map((part, index) =>
        part.mark ? (
          <mark key={index} className="bg-transparent font-semibold">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function starredId(row: PromptRow): string | null {
  return row.kind === "starred" ? row.promptId : row.starredId;
}

function PromptPicker({ composer: handle }: { composer: ComposerHandle }) {
  const pluginId = usePluginId();
  const kind = handle.surface;
  const scopeKey = `${pluginId}:scope:${kind}`;
  const available = scopesFor(kind).filter(
    (option) =>
      (option !== "thread" || handle.threadId !== null) &&
      (option !== "project" || handle.projectId !== null),
  );
  const [query, setQuery] = useState("");
  const [preferred, setPreferred] = useState(() => storedScope(scopeKey, kind));
  const scope = available.includes(preferred) ? preferred : "global";
  const [selected, setSelected] = useState(0);
  const result = useOp(promptLibrary.search, {
    query,
    scope,
    projectId: handle.projectId,
    threadId: handle.threadId,
    composer: kind,
  });
  const star = useCall(promptLibrary.create);
  const unstar = useCall(promptLibrary.delete);
  const markUsed = useCall(promptLibrary.update);
  const rows = result.data?.prompts ?? [];
  const current = rows[Math.min(selected, rows.length - 1)];

  useEffect(() => setSelected(0), [query, scope]);

  function chooseScope(next: PromptScope): void {
    window.localStorage.setItem(scopeKey, next);
    setPreferred(next);
  }

  function close(): void {
    setTarget(null);
    handle.focus();
  }

  function insert(row: PromptRow): void {
    if (handle.isEmpty) handle.setText(row.text);
    else handle.insert(row.text);
    if (row.kind === "starred") void markUsed({ promptId: row.promptId });
    close();
  }

  async function toggleStar(row: PromptRow): Promise<void> {
    const id = starredId(row);
    if (id === null) await star({ text: row.text });
    else await unstar({ promptId: id });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move !== undefined && rows.length > 0) {
      event.preventDefault();
      setSelected((index) => (index + move + rows.length) % rows.length);
    } else if (event.key === "Enter" && current !== undefined) {
      event.preventDefault();
      insert(current);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      const index = available.indexOf(scope) + step + available.length;
      chooseScope(available[index % available.length]!);
    } else if (
      event.key === "s" &&
      (event.metaKey || event.ctrlKey) &&
      current !== undefined
    ) {
      event.preventDefault();
      void toggleStar(current);
    }
  }

  return (
    <div className="flex max-h-80 flex-col gap-2 rounded-lg border bg-background p-2 shadow-sm">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={query}
          placeholder="Search prompts"
          aria-label="Search prompts"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div role="radiogroup" aria-label="Search scope" className="flex">
          {available.map((option) => (
            <Button
              key={option}
              size="sm"
              role="radio"
              aria-checked={option === scope}
              variant={option === scope ? "secondary" : "ghost"}
              onClick={() => chooseScope(option)}
            >
              {SCOPE_LABELS[option]}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" aria-label="Close" onClick={close}>
          <Icon name="X" />
        </Button>
      </div>
      {!handle.isEmpty ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => void star({ text: handle.text })}
        >
          <Icon name="Star" /> Star current draft
        </Button>
      ) : null}
      {result.status === "error" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          Could not search prompts.
          <Button size="sm" variant="ghost" onClick={() => result.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      <ul role="listbox" aria-label="Prompts" className="overflow-y-auto">
        {rows.map((row, index) => (
          <li
            key={`${row.kind}:${row.promptId}`}
            role="option"
            aria-selected={row === current}
            className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm ${
              row === current ? "bg-accent" : ""
            }`}
            onClick={() => setSelected(index)}
            onDoubleClick={() => insert(row)}
          >
            <button
              type="button"
              aria-label={starredId(row) === null ? "Star" : "Unstar"}
              onClick={(event) => {
                event.stopPropagation();
                void toggleStar(row);
              }}
            >
              <Icon
                name="Star"
                className={starredId(row) === null ? "opacity-40" : ""}
              />
            </button>
            <Highlighted snippet={row.snippet} />
            {row.kind === "recent" && row.projectName !== null ? (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {row.projectName}
              </span>
            ) : null}
          </li>
        ))}
        {result.status !== "loading" && rows.length === 0 ? (
          <li className="px-2 py-1 text-sm text-muted-foreground">
            No prompts found
          </li>
        ) : null}
      </ul>
      {current !== undefined ? (
        <div className="flex items-start gap-2 border-t pt-2">
          <pre className="max-h-32 flex-1 overflow-y-auto whitespace-pre-wrap text-xs">
            {current.text}
          </pre>
          <Button size="sm" onClick={() => insert(current)}>
            Insert
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PromptBanner({ composer: handle }: { composer: ComposerHandle }) {
  const target = useTarget();
  if (target === null) return null;
  const mine =
    target.composerKey === null
      ? target.threadId === handle.threadId
      : target.composerKey === handle.key;
  if (!mine) return null;
  return <PromptPicker composer={handle} />;
}

export default function promptLibraryApp(bb: PluginAppApi): void {
  bb.add(composer.banner, { id: "prompt-library", view: PromptBanner });
  bb.add(composer.menuItem, {
    id: "prompts",
    label: "Prompts…",
    icon: "Clock",
    run: (context) =>
      setTarget({
        composerKey: context.composer?.key ?? null,
        threadId: context.threadId,
      }),
  });
  bb.add(shell.command, {
    id: "search-prompts",
    title: "Search prompts",
    defaultShortcut: { key: "r", control: true },
    run: (context) =>
      setTarget({
        composerKey: context.composerKey,
        threadId: context.threadId,
      }),
  });
}
