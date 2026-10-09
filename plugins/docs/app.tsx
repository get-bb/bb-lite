import { useEffect, useState } from "react";
import { diffLines } from "diff";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  Markdown,
  shell,
  sidePanel,
  threadView,
  useBbNavigate,
  useCall,
  useOp,
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
  const [error, setError] = useState<string | null>(null);
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
      {proposal.status === "pending" && (
        <Diff before={proposal.baseContent} after={proposal.content} />
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function DocEditor({ at, compact = false }: { at: DocRef; compact?: boolean }) {
  const file = useOp(docs.read, at);
  const proposal = useOp(docs.proposal, at);
  const write = useCall(docs.write);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(compact);
  const [status, setStatus] = useState("");
  const saved = file.data?.contentEncoding === "utf8" ? file.data.content : "";
  useEffect(() => setDraft(null), [saved]);
  if (file.status === "loading") return <p className="p-2 text-sm">Loading…</p>;
  if (!file.data) return <p className="p-2 text-sm">{message(file.error)}</p>;
  const { sha256 } = file.data;
  const text = draft ?? saved;
  const save = () => {
    setStatus("Saving…");
    write({ ...at, content: text, expectedSha256: sha256 }).then(
      () => setStatus("Saved"),
      (failure: unknown) => setStatus(message(failure)),
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground flex-1 truncate">{status}</span>
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
        <Button size="sm" disabled={draft === null} onClick={save}>
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
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {opened ? (
          <DocEditor at={opened} />
        ) : (
          <p className="text-muted-foreground text-sm">Choose a document.</p>
        )}
      </main>
    </div>
  );
}

function DocPanel({ params }: SidePanelPanelProps) {
  const at = DocRefSchema.safeParse(params);
  return at.success ? <DocEditor at={at.data} /> : null;
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
}
