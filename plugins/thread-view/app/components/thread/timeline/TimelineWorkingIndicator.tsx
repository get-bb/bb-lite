import type { ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow";

const INDICATOR_HEADER_CLASS_NAME = "min-h-7 items-center";

export function TimelineStatusIndicator({
  label,
  className,
}: {
  label: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-2 text-sm text-muted-foreground", className)}>
      {label}
    </div>
  );
}

export function TimelineReasoningDetail({ text }: { text: string }) {
  return (
    <div className="max-h-80 overflow-auto whitespace-pre-wrap break-words ms-1.5 border-l border-border-seam pl-3 text-sm leading-relaxed text-muted-foreground">
      {text}
    </div>
  );
}

export function TimelineWorkingIndicator({
  label,
  isThinking = false,
  details,
  reasoningId,
}: {
  label?: string;
  isThinking?: boolean;
  details?: string;
  reasoningId?: string;
}) {
  const resolvedLabel = label ?? (isThinking ? "Thinking…" : "Working...");
  const hasDetails = (details?.trim().length ?? 0) > 0;

  if (isThinking || hasDetails) {
    return (
      <div className="mt-4">
        <ExpandableTimelineRow
          reasoningExpansionKey={reasoningId}
          expandable={hasDetails}
          headerClassName={INDICATOR_HEADER_CLASS_NAME}
          title={{
            segments: [
              { text: resolvedLabel, em: false, shimmer: true, truncate: true },
            ],
            decorations: [],
            tone: "default",
            action: null,
            plain: resolvedLabel,
          }}
          renderBody={() => <TimelineReasoningDetail text={details ?? ""} />}
        />
      </div>
    );
  }

  return (
    <TimelineStatusIndicator
      label={<span className="animate-shine">{resolvedLabel}</span>}
      className={cn("mt-4 flex", INDICATOR_HEADER_CLASS_NAME)}
    />
  );
}
