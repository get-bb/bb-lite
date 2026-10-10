import { callOp, useBbNavigate, useOp } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { useState } from "react";
import { github } from "../contract.js";
import { linksFor, toggle } from "./logic.js";
import {
  attempt,
  Chips,
  CommentBox,
  CommentView,
  PickList,
  Section,
  StateBadge,
  ThreadLinks,
  useLinks,
  useSpawn,
} from "./parts.js";

export function IssueDetail({
  repo,
  number,
  onBack,
}: {
  repo: string;
  number: number;
  onBack(): void;
}) {
  const navigate = useBbNavigate();
  const issue = useOp(github.issue, { repo, number });
  const links = linksFor(useLinks(), { repo, number });
  const { spawn, busy } = useSpawn();
  const [editing, setEditing] = useState<"assignees" | "labels" | null>(null);
  const users = useOp(
    github.assignableUsers,
    { repo },
    { enabled: editing === "assignees" },
  );
  const labels = useOp(
    github.labels,
    { repo },
    { enabled: editing === "labels" },
  );
  const data = issue.data;
  if (data === undefined) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {issue.error?.message ?? "Loading…"}
      </div>
    );
  }
  const update = async (patch: {
    state?: "open" | "closed";
    assignees?: string[];
    labels?: string[];
  }) => {
    if (
      await attempt(() =>
        callOp(github.updateIssue, { repo, number, ...patch }),
      )
    )
      issue.refetch();
  };
  const open = data.state.toLowerCase() === "open";
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Issues
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
          onClick={() => spawn("work", { repo, number })}
        >
          Send agent
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {data.title}{" "}
          <span className="font-normal text-muted-foreground">#{number}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StateBadge state={data.state} />
          <span>
            {repo} · opened by {data.author}
          </span>
          <ThreadLinks links={links} />
        </div>
      </div>
      <CommentView
        author={data.author}
        createdAt={data.updatedAt}
        body={data.body}
      />
      {data.comments.map((comment, index) => (
        <CommentView key={index} {...comment} />
      ))}
      <CommentBox
        onSubmit={async (body) => {
          const done = await attempt(() =>
            callOp(github.createIssueComment, { repo, number, body }),
          );
          if (done) issue.refetch();
          return done !== null;
        }}
      />
      <Section title="Assignees">
        <div className="flex flex-wrap items-center gap-1">
          <Chips values={data.assignees} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setEditing(editing === "assignees" ? null : "assignees")
            }
          >
            Edit
          </Button>
        </div>
        {editing === "assignees" && (
          <PickList
            options={users.data?.users ?? []}
            selected={data.assignees}
            onToggle={(login) =>
              update({ assignees: toggle(data.assignees, login) })
            }
          />
        )}
      </Section>
      <Section title="Labels">
        <div className="flex flex-wrap items-center gap-1">
          <Chips values={data.labels} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(editing === "labels" ? null : "labels")}
          >
            Edit
          </Button>
        </div>
        {editing === "labels" && (
          <PickList
            options={labels.data?.labels ?? []}
            selected={data.labels}
            onToggle={(label) => update({ labels: toggle(data.labels, label) })}
          />
        )}
      </Section>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => update({ state: open ? "closed" : "open" })}
      >
        {open ? "Close issue" : "Reopen issue"}
      </Button>
    </div>
  );
}
