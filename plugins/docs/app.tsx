import { useEffect, useState } from "react";
import { diffLines } from "diff";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  Markdown,
  callOp,
  shell,
  sidePanel,
  threadView,
  useBbContext,
  useBbNavigate,
  useCall,
  useOp,
  type FileViewerProps,
  type MessageDirectiveProps,
  type PluginAppApi,
  type ShellNavPanelProps,
  type SidePanelPanelProps,
} from "@bb/plugin/app";
import { z } from "zod";
import { docs, type Proposal } from "./contract";

const DocRefSchema = z.object({ vault: z.string(), path: z.string() });
type DocRef = z.infer<typeof DocRefSchema>;

const splitSubPath = (subPath: string): DocRef | null => {
  const [vault, ...rest] = subPath.split("/").filter(Boolean);
  return vault && rest.length ? { vault, path: rest.join("/") } : null;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const failureStatus = (error: unknown): number | null =>
  error instanceof Error &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : null;

export const NOT_FOUND_TEXT =
  "Document not found. It may have been renamed or deleted.";

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded border p-2 text-xs whitespace-pre-wrap">
      {diffLines(before, after).map((part, index) => (
        <span
          key={index}
          className={cn(
            part.added && "bg-green-500/15 text-green-700 dark:text-green-300",
            part.removed && "bg-red-500/15 text-red-700 line-through",
          )}
        >
          {part.value}
        </span>
      ))}
    </pre>
  );
}

function ProposalBar({ at, proposal }: { at: DocRef; proposal: Proposal }) {
  const resolve = useCall(docs.resolveProposal);
  const update = useCall(docs.updateProposal);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const saveCandidate = (content: string) =>
    update({ ...at, content, expectedVersion: proposal.version }).then(
      () => setEditing(null),
      (failure: unknown) => setError(message(failure)),
    );
  const act = (action: "accept" | "reject" | "undo" | "redo") =>
    resolve({ ...at, action, expectedVersion: proposal.version }).then(
      () => setError(null),
      (failure: unknown) => setError(message(failure)),
    );
  const actions = {
    pending: ["accept", "reject"],
    accepted: ["undo"],
    undone: ["redo"],
    rejected: [],
  } as const;
  return (
    <div className="flex flex-col gap-2 rounded border p-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">
          Proposal v{proposal.version}: {proposal.status}
        </span>
        <span className="flex-1" />
        {proposal.status === "pending" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              editing === null
                ? setEditing(proposal.content)
                : void saveCandidate(editing)
            }
          >
            {editing === null ? "Edit" : "Save candidate"}
          </Button>
        )}
        {actions[proposal.status].map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === "accept" ? "default" : "outline"}
            onClick={() => void act(action)}
          >
            {action[0]?.toUpperCase()}
            {action.slice(1)}
          </Button>
        ))}
      </div>
      {editing !== null ? (
        <textarea
          className="bg-background min-h-40 rounded border p-2 font-mono text-sm"
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
        />
      ) : (
        proposal.status === "pending" && (
          <Diff before={proposal.baseContent} after={proposal.content} />
        )
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

const fileBase64 = (file: File) =>
  file.arrayBuffer().then((buffer) => {
    let binary = "";
    for (const byte of new Uint8Array(buffer))
      binary += String.fromCharCode(byte);
    return btoa(binary);
  });

function DocEditor({
  at,
  compact = false,
  onRenamed,
}: {
  at: DocRef;
  compact?: boolean;
  onRenamed?: (path: string) => void;
}) {
  const file = useOp(docs.read, at);
  const proposal = useOp(docs.proposal, at);
  const write = useCall(docs.write);
  const upload = useCall(docs.uploadAttachment);
  const rename = useCall(docs.renameToTitle);
  const { threadId } = useBbContext();
  const { vault, path } = at;
  useEffect(() => {
    if (threadId)
      void callOp(docs.visit, { threadId, vault, path }).catch(() => undefined);
  }, [threadId, vault, path]);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(compact);
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const saved = file.data?.contentEncoding === "utf8" ? file.data.content : "";
  useEffect(() => setDraft(null), [saved]);
  if (file.status === "loading") return <p className="p-2 text-sm">Loading…</p>;
  if (!file.data) {
    const missing = failureStatus(file.error) === 404;
    return (
      <p className="p-2 text-sm text-muted-foreground">
        {missing ? NOT_FOUND_TEXT : message(file.error)}
      </p>
    );
  }
  const { sha256 } = file.data;
  const text = draft ?? saved;
  const save = (overwrite = false) => {
    setStatus("Saving…");
    setConflict(false);
    const expectedSha256 = overwrite ? undefined : sha256;
    write({ ...at, content: text, expectedSha256 }).then(
      () => setStatus("Saved"),
      (failure: unknown) => {
        const changed = failureStatus(failure) === 409;
        setConflict(changed);
        setStatus(changed ? "Changed on disk." : message(failure));
      },
    );
  };
  const reload = () => {
    setConflict(false);
    setStatus("");
    setDraft(null);
    void file.refetch();
  };
  const attach = async (picked: File) => {
    const contentBase64 = await fileBase64(picked);
    const { markdown } = await upload({
      ...at,
      name: picked.name,
      contentBase64,
    });
    setDraft(`${text}\n${markdown}\n`);
  };
  const renameToTitle = () =>
    rename(at).then(
      (renamed) => onRenamed?.(renamed.path),
      (failure: unknown) => setStatus(message(failure)),
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground flex-1 truncate">{status}</span>
        {conflict && (
          <>
            <Button size="sm" variant="ghost" onClick={reload}>
              Reload
            </Button>
            <Button size="sm" variant="ghost" onClick={() => save(true)}>
              Overwrite
            </Button>
          </>
        )}
        <label className="hover:bg-muted cursor-pointer rounded px-2 py-1">
          Attach
          <input
            type="file"
            className="hidden"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (picked)
                attach(picked).catch((failure: unknown) =>
                  setStatus(message(failure)),
                );
            }}
          />
        </label>
        {onRenamed && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void renameToTitle()}
          >
            Rename to title
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)}>
          {preview ? "Edit" : "Preview"}
        </Button>
        <Button size="sm" disabled={draft === null} onClick={() => save()}>
          Save
        </Button>
      </div>
      {proposal.data && <ProposalBar at={at} proposal={proposal.data} />}
      {preview ? (
        <Markdown content={text} />
      ) : (
        <textarea
          className="bg-background min-h-64 flex-1 rounded border p-2 font-mono text-sm"
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft !== null && save()}
        />
      )}
    </div>
  );
}

type Entry = { path: string; kind: "file" | "directory" };

function Folder({
  vault,
  folder,
  entries,
  selected,
  open,
}: {
  vault: string;
  folder: string;
  entries: Entry[];
  selected: string | undefined;
  open: (path: string) => void;
}) {
  const stored = useOp(docs.order, { vault, folder });
  const reorder = useCall(docs.reorder);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const prefix = folder ? `${folder}/` : "";
  const children = entries.filter(
    (e) =>
      e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"),
  );
  const rank = (e: Entry) => {
    const at = (stored.data ?? []).indexOf(e.path.slice(prefix.length));
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const sorted = [...children].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.kind.localeCompare(b.kind) ||
      a.path.localeCompare(b.path),
  );
  const names = sorted.map((e) => e.path.slice(prefix.length));
  const move = (index: number, by: number) => {
    const next = [...names];
    const [name] = next.splice(index, 1);
    if (name === undefined) return;
    next.splice(Math.max(0, index + by), 0, name);
    void reorder({ vault, folder, names: next });
  };
  return (
    <ul className={cn("text-sm", folder && "border-l pl-2")}>
      {sorted.map((entry, index) => {
        const name = names[index];
        const isOpen = entry.kind === "directory" && !closed.has(entry.path);
        const toggle = () => {
          const next = new Set(closed);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          setClosed(next);
        };
        return (
          <li key={entry.path}>
            <div className="group flex items-center">
              <button
                type="button"
                className={cn(
                  "hover:bg-muted flex-1 truncate rounded px-2 py-1 text-left",
                  selected === entry.path && "bg-muted",
                )}
                onClick={() =>
                  entry.kind === "directory" ? toggle() : open(entry.path)
                }
              >
                {entry.kind === "directory" ? (isOpen ? "▾ " : "▸ ") : ""}
                {name}
              </button>
              <span className="hidden gap-1 group-hover:flex">
                <button
                  type="button"
                  aria-label="Move up"
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
              </span>
            </div>
            {isOpen && (
              <Folder
                vault={vault}
                folder={entry.path}
                entries={entries}
                selected={selected}
                open={open}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DocsPanel({ subPath }: ShellNavPanelProps) {
  const navigate = useBbNavigate();
  const opened = splitSubPath(subPath);
  const vaults = useOp(docs.vaults, {});
  const [vault, setVault] = useState(opened?.vault ?? "personal");
  const [filter, setFilter] = useState("");
  const entries = useOp(docs.list, { vault });
  const write = useCall(docs.write);
  const open = (path: string) =>
    navigate.toPluginPanel("docs", { subPath: `${vault}/${path}` });
  const create = () => {
    const path = filter.endsWith(".md") ? filter : `${filter}.md`;
    void write({ vault, path, content: "", expectedSha256: null }).then(() =>
      open(path),
    );
  };
  const files = (entries.data ?? []).filter(
    (e) => e.kind === "file" && e.path.includes(filter),
  );
  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      <aside className="flex w-64 shrink-0 flex-col gap-2">
        <select
          className="bg-background rounded border p-1 text-sm"
          value={vault}
          onChange={(event) => setVault(event.target.value)}
        >
          {(vaults.data ?? []).map((v) => (
            <option key={v.vaultId} value={v.vaultId}>
              {v.name}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          <Input
            placeholder="Search or new path"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <Button size="sm" disabled={!filter} onClick={create}>
            New
          </Button>
        </div>
        {!filter ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <Folder
              vault={vault}
              folder=""
              entries={entries.data ?? []}
              selected={opened?.path}
              open={open}
            />
          </div>
        ) : (
          <ul className="min-h-0 flex-1 overflow-auto text-sm">
            {files.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={cn(
                    "hover:bg-muted w-full truncate rounded px-2 py-1 text-left",
                    opened?.path === entry.path && "bg-muted",
                  )}
                  onClick={() => open(entry.path)}
                >
                  {entry.path}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {opened ? (
          <DocEditor at={opened} onRenamed={(path) => open(path)} />
        ) : (
          <p className="text-muted-foreground text-sm">Choose a document.</p>
        )}
      </main>
    </div>
  );
}

function DocPanel({ params }: SidePanelPanelProps) {
  const parsed = DocRefSchema.safeParse(params);
  const { threadId } = useBbContext();
  const [at, setAt] = useState(parsed.success ? parsed.data : null);
  const recent = useOp(
    docs.recent,
    { threadId: threadId ?? "" },
    { enabled: threadId !== null },
  );
  const others = (recent.data ?? []).filter(
    (r) => r.vault !== at?.vault || r.path !== at?.path,
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1 text-xs">
          {others.map((r) => (
            <Button
              key={`${r.vault}/${r.path}`}
              size="sm"
              variant="outline"
              onClick={() => setAt(r)}
            >
              {r.path}
            </Button>
          ))}
        </div>
      )}
      {at && (
        <DocEditor
          key={`${at.vault}/${at.path}`}
          at={at}
          onRenamed={(path) => setAt({ ...at, path })}
        />
      )}
    </div>
  );
}

function MarkdownFileViewer({
  path,
  threadId,
  source,
  content,
}: FileViewerProps) {
  const editable = threadId !== null;
  const opened = useOp(
    docs.openFile,
    { threadId: threadId ?? "", path, source },
    { enabled: editable },
  );
  const save = useCall(docs.saveOpenedFile);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);
  const [status, setStatus] = useState("");
  const saved = opened.data?.content ?? content ?? "";
  useEffect(() => setDraft(null), [saved]);
  const text = draft ?? saved;
  const store = () => {
    if (!threadId || draft === null) return;
    setStatus("Saving…");
    const expectedSha256 = opened.data?.sha256 ?? null;
    save({ threadId, path, source, content: draft, expectedSha256 }).then(
      () => setStatus("Saved"),
      (failure: unknown) => setStatus(message(failure)),
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground flex-1 truncate">{status}</span>
        {editable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPreview(!preview)}
          >
            {preview ? "Edit" : "Preview"}
          </Button>
        )}
        {editable && (
          <Button size="sm" disabled={draft === null} onClick={store}>
            Save
          </Button>
        )}
      </div>
      {preview ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Markdown
            content={text}
            {...(threadId ? { document: { threadId, path, source } } : {})}
          />
        </div>
      ) : (
        <textarea
          className="bg-background min-h-64 flex-1 rounded border p-2 font-mono text-sm"
          value={text}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
    </div>
  );
}

function DocsDirective({ attributes }: MessageDirectiveProps) {
  const navigate = useBbNavigate();
  const { vault, path, title } = attributes;
  if (!vault || !path)
    return <p className="text-sm">::docs needs vault and path</p>;
  return (
    <div className="my-2 flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="flex-1 truncate font-medium">{title ?? path}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            navigate.toPluginPanel("docs", { subPath: `${vault}/${path}` })
          }
        >
          Open in tab
        </Button>
      </div>
      {path.endsWith(".md") && <DocEditor at={{ vault, path }} compact />}
    </div>
  );
}

export default function docsApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "docs",
    title: "Docs",
    icon: "FileText",
    path: "docs",
    view: DocsPanel,
  });
  bb.add(sidePanel.panel, {
    id: "doc",
    title: "Doc",
    icon: "FileText",
    view: DocPanel,
  });
  bb.add(threadView.messageDirective, { id: "docs", view: DocsDirective });
  bb.add(sidePanel.fileViewer, {
    id: "markdown",
    extensions: ["md", "markdown"],
    view: MarkdownFileViewer,
  });
}
