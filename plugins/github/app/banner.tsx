import { callOp, useOp } from "@bb/plugin/app";
import type { ThreadContextSegmentProps } from "@bb/plugin/app";
import {
  CONTEXT_CARD_ACTION_BUTTON_CLASS,
  CONTEXT_CARD_SEGMENT_CLASS,
} from "@bb/shared-ui/chrome-style-tokens";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { useState } from "react";
import { pullRequests } from "../contract.js";
import { errorText, pullStateLabel } from "./logic.js";

type MergeMethod = "merge" | "squash" | "rebase";

const MERGE_ACTIONS: readonly { method: MergeMethod; label: string }[] = [
  { method: "merge", label: "Merge" },
  { method: "squash", label: "Squash merge" },
  { method: "rebase", label: "Rebase and merge" },
];
const SEGMENT_CLASS = cn(
  "flex min-w-8 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground no-underline transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  CONTEXT_CARD_SEGMENT_CLASS,
);
const SPLIT_CLASS =
  "inline-flex items-center overflow-hidden rounded border border-border bg-background shadow-xs";
const SPLIT_PART_CLASS = cn(
  CONTEXT_CARD_ACTION_BUTTON_CLASS,
  "rounded-none border-0 shadow-none",
);

function useThreadPull(threadId: string) {
  const found = useOp(pullRequests.forThread, { threadId });
  const environmentId = found.data?.pull?.environmentId ?? "";
  const query = useOp(
    pullRequests.get,
    { environmentId },
    { enabled: environmentId !== "" },
  );
  const pull = environmentId === "" ? null : (query.data ?? null);
  return { environmentId, pull, refetch: query.refetch };
}

export function PullRequestSegment({ threadId }: ThreadContextSegmentProps) {
  const { pull } = useThreadPull(threadId);
  if (pull === null) return null;
  const label = pullStateLabel(pull);
  const open = pull.state === "open" && !pull.isDraft;
  return (
    <a
      href={pull.url}
      target="_blank"
      rel="noopener noreferrer"
      title={pull.title}
      aria-label={`Pull request ${pull.number}: ${label}`}
      className={SEGMENT_CLASS}
    >
      <Icon name="GitPullRequest" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        PR #{pull.number}
        {open ? "" : ` · ${label}`}
      </span>
    </a>
  );
}

export function PullRequestAction({ threadId }: ThreadContextSegmentProps) {
  const { environmentId, pull, refetch } = useThreadPull(threadId);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (pull === null || pull.state !== "open") return null;
  const run = async (label: string, action: () => Promise<unknown>) => {
    setPending(label);
    setError(null);
    try {
      await action();
      await refetch();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setPending(null);
    }
  };
  const setDraft = (draft: boolean) =>
    run(draft ? "Converting..." : "Marking...", () =>
      callOp(pullRequests.update, { environmentId, draft }),
    );
  const merge = (method: MergeMethod) =>
    run("Merging...", () =>
      callOp(pullRequests.merge, { environmentId, method }),
    );
  const busy = pending !== null;
  const failure =
    error === null ? null : (
      <span role="alert" className="max-w-48 truncate text-destructive">
        {error}
      </span>
    );
  if (pull.isDraft) {
    return (
      <>
        {failure}
        <button
          type="button"
          className={CONTEXT_CARD_ACTION_BUTTON_CLASS}
          disabled={busy}
          onClick={() => void setDraft(false)}
        >
          {pending ?? "Mark ready"}
        </button>
      </>
    );
  }
  return (
    <>
      {failure}
      <div className={SPLIT_CLASS}>
        <button
          type="button"
          className={SPLIT_PART_CLASS}
          disabled={busy}
          onClick={() => void merge("merge")}
        >
          {pending ?? "Merge"}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(SPLIT_PART_CLASS, "border-l border-border px-1")}
              disabled={busy}
              aria-label="Choose pull request merge method"
            >
              <Icon name="ChevronDown" className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={2}>
            {MERGE_ACTIONS.map((action) => (
              <DropdownMenuItem
                key={action.method}
                onSelect={() => void merge(action.method)}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void setDraft(true)}>
              Convert to draft
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
