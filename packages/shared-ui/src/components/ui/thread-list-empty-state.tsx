import { EmptyState } from "./empty-state.js";

export function ThreadListEmptyState({
  message = "No threads",
  className,
}: {
  message?: string;
  className?: string;
}) {
  return (
    <EmptyState
      message={message}
      icon="MessageSquare"
      className={className}
      iconClassName="size-3.5 text-subtle-foreground/50"
      messageClassName="text-xs leading-4 text-subtle-foreground/60"
    />
  );
}
