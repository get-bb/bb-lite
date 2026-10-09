import { callOp, useOp } from "@bb/plugin/app";
import type { ComposerHandle } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { CONTEXT_CARD_CLASS } from "@bb/shared-ui/chrome-style-tokens";
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

export function PullRequestBanner({ composer }: { composer: ComposerHandle }) {
  const threadId = composer.threadId ?? "";
  const found = useOp(
    pullRequests.forThread,
    { threadId },
    { enabled: threadId !== "" },
  );
  const environmentId = found.data?.pull?.environmentId ?? null;
  if (environmentId === null) return null;
  return <EnvironmentPull environmentId={environmentId} />;
}

function EnvironmentPull({ environmentId }: { environmentId: string }) {
  const query = useOp(pullRequests.get, { environmentId });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pull = query.data ?? null;
  if (pull === null) return null;
  const run = async (label: string, action: () => Promise<unknown>) => {
    setPending(label);
    setError(null);
    try {
      await action();
      await query.refetch();
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
  const open = pull.state === "open";
  const label = pullStateLabel(pull);
  return (
    <section
      aria-label="Pull request"
      className={cn(
        CONTEXT_CARD_CLASS,
        "flex items-center gap-2 px-3 py-1.5 text-xs",
      )}
    >
      <Icon name="GitPullRequest" className="size-3.5 shrink-0" />
      <a
        href={pull.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 truncate hover:underline"
        aria-label={`Pull request ${pull.number}: ${label}`}
      >
        PR #{pull.number}
        {open && !pull.isDraft ? "" : ` · ${label}`}
      </a>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {error ?? pull.title}
      </span>
      {open && pull.isDraft ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void setDraft(false)}
        >
          {pending ?? "Mark ready"}
        </Button>
      ) : null}
      {open && !pull.isDraft ? (
        <div className="flex items-center">
          <Button
            size="sm"
            variant="outline"
            className="rounded-r-none"
            disabled={pending !== null}
            onClick={() => void merge("merge")}
          >
            {pending ?? "Merge"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="rounded-l-none border-l-0 px-1"
                disabled={pending !== null}
                aria-label="Choose pull request merge method"
              >
                <Icon name="ChevronDown" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
      ) : null}
    </section>
  );
}
