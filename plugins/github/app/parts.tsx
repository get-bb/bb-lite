import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { callOp, Markdown, useBbNavigate, useOp } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { Textarea } from "@bb/shared-ui/textarea";
import { type ReactNode, useState } from "react";
import { github, pullRequests, type ThreadLink } from "../contract.js";
import { errorText, relativeTime } from "./logic.js";

export function useViewer(): string | null {
  return useOp(github.viewer, {}).data?.login ?? null;
}

export function useLinks(): ThreadLink[] {
  return useOp(github.links, {}).data ?? [];
}

export async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    appToast.error(errorText(error));
    return null;
  }
}

export function useSpawn() {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const spawn = async (
    action: "work" | "review",
    ref: { repo: string; number: number },
  ) => {
    setBusy(`${ref.repo}#${ref.number}`);
    const result = await attempt(() =>
      action === "work"
        ? callOp(github.startWork, ref)
        : callOp(pullRequests.createReview, ref),
    );
    setBusy(null);
    if (result !== null) navigate.toThread(result.threadId);
  };
  return { spawn, busy };
}

const STATE_CLASS: Record<string, string> = {
  open: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  merged: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  closed: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  draft: "bg-muted text-muted-foreground",
};

export function StateBadge({ state }: { state: string }) {
  const key = state.toLowerCase();
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        STATE_CLASS[key] ?? STATE_CLASS.draft,
      )}
    >
      {key}
    </span>
  );
}

export function Chips({ values }: { values: string[] }) {
  return values.map((value) => (
    <span
      key={value}
      className="rounded-full border border-border px-1.5 text-[11px] text-muted-foreground"
    >
      {value}
    </span>
  ));
}

export function ThreadLinks({ links }: { links: ThreadLink[] }) {
  const navigate = useBbNavigate();
  return links.map((link) => (
    <button
      key={link.threadId}
      type="button"
      className="text-[11px] text-primary hover:underline"
      onClick={(event) => {
        event.stopPropagation();
        navigate.toThread(link.threadId);
      }}
    >
      {link.kind === "pr" ? "review" : "thread"} {relativeTime(link.createdAt)}
    </button>
  ));
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function CommentView({
  author,
  createdAt,
  body,
  extra,
}: {
  author: string;
  createdAt: string;
  body: string;
  extra?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
        <span className="font-medium">{author}</span>
        {extra}
        <span className="text-muted-foreground">{relativeTime(createdAt)}</span>
      </div>
      <div className="px-3 py-2 text-sm">
        {body.trim() === "" ? (
          <span className="text-muted-foreground italic">No description.</span>
        ) : (
          <Markdown content={body} />
        )}
      </div>
    </div>
  );
}

export function CommentBox({
  onSubmit,
}: {
  onSubmit(body: string): Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={body}
        rows={3}
        placeholder="Leave a comment…"
        onChange={(event) => setBody(event.target.value)}
      />
      <Button
        size="sm"
        className="self-end"
        disabled={busy || body.trim() === ""}
        onClick={async () => {
          setBusy(true);
          if (await onSubmit(body)) setBody("");
          setBusy(false);
        }}
      >
        Comment
      </Button>
    </div>
  );
}

export function PickList({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle(value: string): void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={selected.includes(option)}
          onClick={() => onToggle(option)}
          className="rounded-full border border-border px-2 py-0.5 text-xs aria-pressed:border-primary aria-pressed:bg-primary/10"
        >
          {option}
        </button>
      ))}
    </div>
  );
}
