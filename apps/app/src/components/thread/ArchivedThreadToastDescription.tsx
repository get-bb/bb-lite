import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";

export function ArchivedThreadToastDescription({
  archivedThreadCount,
  onOpenThread,
  threadTitle,
}: {
  archivedThreadCount: number;
  onOpenThread: () => void;
  threadTitle: string;
}) {
  const children = archivedThreadCount - 1;
  const displayTitle = useThreadTitleDisplayText(threadTitle);
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={displayTitle}
        onClick={onOpenThread}
      >
        <ThreadTitle title={threadTitle} />
      </button>
      {children > 0 ? (
        <>
          <span className="shrink-0" aria-hidden>
            +{children}
          </span>
          <span className="sr-only">
            {children === 1
              ? " and 1 child thread"
              : ` and ${children} child threads`}
          </span>
        </>
      ) : null}
    </span>
  );
}
