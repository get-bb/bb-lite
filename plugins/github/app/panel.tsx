import { callOp, useBbNavigate, useOp } from "@bb/plugin/app";
import type { ShellNavPanelProps } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { useState } from "react";
import { github, type Item, type ThreadLink } from "../contract.js";
import { IssueDetail } from "./issue.js";
import {
  filterItems,
  linksFor,
  parseSubPath,
  relativeTime,
  type Route,
  routeToSubPath,
} from "./logic.js";
import {
  attempt,
  Chips,
  StateBadge,
  ThreadLinks,
  useLinks,
  useSpawn,
  useViewer,
} from "./parts.js";
import { PullDetail } from "./pull.js";

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs";

function useRoute(subPath: string): [Route, (route: Route) => void] {
  const navigate = useBbNavigate();
  return [
    parseSubPath(subPath),
    (route) =>
      navigate.toPluginPanel("github", { subPath: routeToSubPath(route) }),
  ];
}

export function GithubHeader() {
  const status = useOp(github.status, {});
  const repos = useOp(github.repos, {});
  const [syncing, setSyncing] = useState(false);
  const data = status.data;
  const count = repos.data?.repos.length ?? 0;
  const text =
    data === undefined
      ? "Loading…"
      : !data.ready
        ? (data.error ?? "GitHub CLI not ready. Check `gh auth status`.")
        : `${count} repo${count === 1 ? "" : "s"} · synced ${
            data.lastSyncAt === null ? "never" : relativeTime(data.lastSyncAt)
          }`;
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
      <span className="truncate text-xs text-muted-foreground">{text}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={syncing || data?.syncing === true}
        onClick={async () => {
          setSyncing(true);
          await attempt(() => callOp(github.sync, {}));
          setSyncing(false);
          status.refetch();
        }}
      >
        {syncing || data?.syncing ? "Syncing…" : "Refresh"}
      </Button>
    </div>
  );
}

function NewIssueForm({ repos, onDone }: { repos: string[]; onDone(): void }) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-2 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const created = await attempt(() =>
          callOp(github.createIssue, { repo, title, body }),
        );
        setBusy(false);
        if (created !== null) onDone();
      }}
    >
      <select
        className={selectClass}
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
      >
        {repos.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
      <Input
        value={title}
        placeholder="Title"
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        value={body}
        rows={8}
        placeholder="Description (markdown)"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={busy || repo === "" || title.trim() === ""}
        >
          Create issue
        </Button>
      </div>
    </form>
  );
}

function ItemRow({
  item,
  links,
  onOpen,
}: {
  item: Item;
  links: ThreadLink[];
  onOpen(): void;
}) {
  const { spawn, busy } = useSpawn();
  const pr = item.kind === "pr";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => event.key === "Enter" && onOpen()}
      className="group flex items-start gap-2 border-b border-border px-4 py-2 hover:bg-state-hover"
    >
      <StateBadge state={item.state} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{item.title}</span>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>
            {item.repo}#{item.number} · {item.author} ·{" "}
            {relativeTime(item.updatedAt)}
          </span>
          <Chips values={item.labels} />
          {item.assignees.length > 0 && (
            <span>→ {item.assignees.join(", ")}</span>
          )}
          <ThreadLinks links={links} />
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
        disabled={busy !== null}
        onClick={(event) => {
          event.stopPropagation();
          void spawn(pr ? "review" : "work", item);
        }}
      >
        {pr ? "Review with agent" : "Send agent"}
      </Button>
    </div>
  );
}

function ItemList({
  kind,
  repos,
  open,
}: {
  kind: "issues" | "pulls";
  repos: string[];
  open(item: Item): void;
}) {
  const [query, setQuery] = useState("is:open ");
  const [repo, setRepo] = useState("");
  const viewer = useViewer();
  const links = useLinks();
  const list = useOp(
    kind === "issues" ? github.issues : github.pulls,
    repo === "" ? {} : { repo },
  );
  const items = filterItems(list.data?.items ?? [], query, viewer);
  return (
    <>
      <div className="flex gap-2 px-4 pb-2">
        <Input
          className="h-8 text-xs"
          value={query}
          placeholder="Filter: is:open assignee:@me label:bug, or plain text"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className={selectClass}
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
        >
          <option value="">All repos</option>
          {repos.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </div>
      {list.error !== null ? (
        <EmptyStatePanel className="mx-4">{list.error.message}</EmptyStatePanel>
      ) : list.status === "loading" ? (
        <EmptyStatePanel className="mx-4">Loading…</EmptyStatePanel>
      ) : items.length === 0 ? (
        <EmptyStatePanel className="mx-4">
          {list.data?.items.length === 0
            ? "Nothing synced yet. Press Refresh."
            : "No matches."}
        </EmptyStatePanel>
      ) : (
        items.map((item) => (
          <ItemRow
            key={`${item.repo}#${item.number}`}
            item={item}
            links={linksFor(links, item)}
            onOpen={() => open(item)}
          />
        ))
      )}
    </>
  );
}

export function GithubPanel({ subPath }: ShellNavPanelProps) {
  const [route, go] = useRoute(subPath);
  const repos = (useOp(github.repos, {}).data?.repos ?? []).map((r) => r.repo);
  if (route.view === "issue") {
    return <IssueDetail {...route} onBack={() => go({ view: "issues" })} />;
  }
  if (route.view === "pull") {
    return (
      <PullDetail
        {...route}
        backLabel="Pull requests"
        onBack={() => go({ view: "pulls" })}
      />
    );
  }
  if (route.view === "new") {
    return <NewIssueForm repos={repos} onDone={() => go({ view: "issues" })} />;
  }
  const tab = (view: "issues" | "pulls", label: string) => (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={route.view === view}
      onClick={() => go({ view })}
    >
      {label}
    </Button>
  );
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-4 py-2">
        {tab("issues", "Issues")}
        {tab("pulls", "Pull requests")}
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => go({ view: "new" })}>
          New issue
        </Button>
      </div>
      <ItemList
        key={route.view}
        kind={route.view}
        repos={repos}
        open={(item) =>
          go({
            view: item.kind === "pr" ? "pull" : "issue",
            repo: item.repo,
            number: item.number,
          })
        }
      />
    </div>
  );
}
