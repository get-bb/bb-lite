import { callOp, Diff, FileLink, useBbNavigate, useOp } from "@bb/plugin/app";
import type { SidePanelPanelProps } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { useState } from "react";
import { github, pullRequests } from "../contract.js";
import { filterItems, linksFor } from "./logic.js";
import {
  attempt,
  Chips,
  CommentBox,
  CommentView,
  Section,
  StateBadge,
  ThreadLinks,
  useLinks,
  useSpawn,
} from "./parts.js";

const CHECK_CLASS = {
  success: "bg-emerald-500",
  failure: "bg-rose-500",
  pending: "bg-amber-500",
  neutral: "bg-muted-foreground",
};

export function PullDetail({
  repo,
  number,
  threadId,
  backLabel,
  onBack,
}: {
  repo: string;
  number: number;
  threadId?: string;
  backLabel: string;
  onBack(): void;
}) {
  const navigate = useBbNavigate();
  const pull = useOp(pullRequests.details, { repo, number });
  const links = linksFor(useLinks(), { repo, number });
  const { spawn, busy } = useSpawn();
  const [openFile, setOpenFile] = useState<string | null>(null);
  const data = pull.data;
  if (data === undefined) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {pull.error?.message ?? "Loading…"}
      </div>
    );
  }
  const state = data.isDraft && data.state === "open" ? "draft" : data.state;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← {backLabel}
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate.openUrl(data.url)}
        >
          Open on GitHub
        </Button>
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => spawn("review", { repo, number })}
        >
          Review with agent
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {data.title}{" "}
          <span className="font-normal text-muted-foreground">#{number}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StateBadge state={state} />
          <span>
            {data.author} wants to merge {data.headRefName} into{" "}
            {data.baseRefName} · +{data.additions} −{data.deletions} in{" "}
            {data.changedFiles} files
          </span>
          {data.reviewDecision !== "" && (
            <span className="lowercase">
              {data.reviewDecision.replace(/_/g, " ")}
            </span>
          )}
          <Chips values={data.labels} />
          <ThreadLinks links={links} />
        </div>
      </div>
      {data.checks.length > 0 && (
        <Section title="Checks">
          {data.checks.map((check) => (
            <button
              key={check.name}
              type="button"
              className="flex items-center gap-2 text-left text-sm hover:underline"
              onClick={() => check.url && navigate.openUrl(check.url)}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  CHECK_CLASS[check.status],
                )}
              />
              {check.name}
            </button>
          ))}
        </Section>
      )}
      {(data.assignees.length > 0 || data.reviewRequests.length > 0) && (
        <Section title="People">
          <div className="flex flex-wrap gap-1 text-xs">
            <Chips values={data.assignees} />
            {data.reviewRequests.length > 0 && (
              <span className="text-muted-foreground">
                review requested: {data.reviewRequests.join(", ")}
              </span>
            )}
          </div>
        </Section>
      )}
      <Section title="Conversation">
        <CommentView
          author={data.author}
          createdAt={data.createdAt}
          body={data.body}
        />
        {[
          ...data.comments.map((comment) => ({ ...comment, state: "" })),
          ...data.reviews,
        ]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((comment, index) => (
            <CommentView
              key={index}
              {...comment}
              extra={
                comment.state !== "" ? (
                  <span className="text-muted-foreground lowercase">
                    {comment.state.replace(/_/g, " ")}
                  </span>
                ) : null
              }
            />
          ))}
        <CommentBox
          onSubmit={async (body) => {
            const done = await attempt(() =>
              callOp(pullRequests.createComment, { repo, number, body }),
            );
            if (done) pull.refetch();
            return done !== null;
          }}
        />
      </Section>
      {data.reviewThreads.length > 0 && (
        <Section title="Review threads">
          {data.reviewThreads.map((thread, index) => (
            <div key={index} className="rounded-md border border-border">
              <div className="px-3 py-1.5 font-mono text-xs">
                <FileLink path={thread.path} threadId={threadId}>
                  {thread.path}
                  {thread.line !== null && `:${thread.line}`}
                </FileLink>
              </div>
              <Diff patch={thread.diffHunk} path={thread.path} />
              <div className="flex flex-col gap-2 p-2">
                {thread.comments.map((comment, at) => (
                  <CommentView key={at} {...comment} />
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}
      <Section title={`Files (${data.files.length})`}>
        {data.files.map((file) => (
          <div key={file.path} className="rounded-md border border-border">
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-mono hover:underline"
                onClick={() =>
                  setOpenFile(openFile === file.path ? null : file.path)
                }
              >
                {file.path}
              </button>
              <span className="text-emerald-600">+{file.additions}</span>
              <span className="text-rose-600">−{file.deletions}</span>
              {threadId !== undefined && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    navigate.openFile({ threadId, path: file.path })
                  }
                >
                  Open
                </Button>
              )}
            </div>
            {openFile === file.path &&
              (file.patch === null ? (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  No textual diff.
                </p>
              ) : (
                <Diff patch={file.patch} path={file.path} />
              ))}
          </div>
        ))}
      </Section>
    </div>
  );
}

export function PullPanelTab({ threadId }: SidePanelPanelProps) {
  const found = useOp(pullRequests.forThread, { threadId });
  const [picked, setPicked] = useState<{ repo: string; number: number }>();
  const [listing, setListing] = useState(false);
  const linked = found.data?.pull ?? null;
  const selected = picked ?? (listing ? null : linked);
  const pulls = useOp(
    github.pulls,
    {},
    { enabled: found.status !== "loading" && selected === null },
  );
  if (found.status === "loading") {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  if (selected === null) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <p className="text-xs text-muted-foreground">
          No pull request is linked to this thread yet. Pick one:
        </p>
        {filterItems(pulls.data?.items ?? [], "is:open", null).map((item) => (
          <button
            key={`${item.repo}#${item.number}`}
            type="button"
            className="truncate rounded px-2 py-1 text-left text-sm hover:bg-state-hover"
            onClick={() => setPicked(item)}
          >
            <span className="text-muted-foreground">#{item.number}</span>{" "}
            {item.title}
          </button>
        ))}
      </div>
    );
  }
  return (
    <PullDetail
      repo={selected.repo}
      number={selected.number}
      threadId={picked === undefined ? threadId : undefined}
      backLabel="All PRs"
      onBack={() => {
        setPicked(undefined);
        setListing(true);
      }}
    />
  );
}
