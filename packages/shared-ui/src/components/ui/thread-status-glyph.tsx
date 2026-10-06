import { Icon, type IconName } from "./icon.js";
import { cn } from "../../lib/utils";
import {
  getThreadListIndicatorLabel,
  resolveThreadListIndicator,
  type ThreadListIndicatorKind,
  type ThreadListIndicatorState,
} from "@bb/client-core";

const WORKING = "text-muted-foreground/50";
const SHINE = `animate-shine-icon ${WORKING}`;
const WAITING = "text-muted-foreground/75";

const GLYPHS: Record<
  Exclude<
    ThreadListIndicatorKind,
    "none" | "unread-success" | "draft" | "working-draft"
  >,
  [IconName, string]
> = {
  "unread-error": ["CircleX", "text-destructive"],
  "queued-failed": ["CircleX", "text-destructive"],
  "waiting-for-input": ["CircleQuestion", WAITING],
  "queued-waiting": ["Clock", WAITING],
  workflow: ["Workflow", SHINE],
  "background-agent": ["UserRoundPlus", SHINE],
  "background-command": ["Terminal", SHINE],
  goal: ["Target", SHINE],
  runtime: ["Loading", `animate-spin motion-reduce:animate-none ${WORKING}`],
};

export function resolveThreadStatus(statusProps: ThreadListIndicatorState): {
  accessibleLabel: string | null;
  indicatorKind: ThreadListIndicatorKind;
} {
  const indicatorKind = resolveThreadListIndicator(statusProps);
  return {
    accessibleLabel: getThreadListIndicatorLabel(indicatorKind),
    indicatorKind,
  };
}

export function ThreadStatusGlyph({
  hideIdleDraftLabel = false,
  ...state
}: ThreadListIndicatorState & { hideIdleDraftLabel?: boolean }) {
  const kind = resolveThreadListIndicator(state);
  const label = getThreadListIndicatorLabel(kind) ?? undefined;
  if (kind === "none") return null;
  if (kind === "unread-success") {
    return (
      <span
        className="size-[5px] rounded-full bg-muted-foreground/60 max-md:pointer-coarse:size-1.5"
        aria-label={label}
      />
    );
  }
  if (kind === "draft" || kind === "working-draft") {
    const isWorking = kind === "working-draft";
    return (
      <Icon
        name="Edit"
        className={cn(
          "pointer-events-none shrink-0 size-4",
          isWorking ? SHINE : "text-muted-foreground",
        )}
        {...(!isWorking && hideIdleDraftLabel
          ? { "aria-hidden": true }
          : { "aria-label": label })}
      />
    );
  }
  const [name, tone] = GLYPHS[kind];
  return <Icon name={name} className={cn(tone, "size-4")} aria-label={label} />;
}
