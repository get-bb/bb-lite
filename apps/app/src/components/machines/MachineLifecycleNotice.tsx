export interface MachineLifecycleNoticeState {
  message: string | null;
}

export function MachineLifecycleNoticeContent({
  notice,
}: {
  notice: MachineLifecycleNoticeState | null;
}) {
  if (notice === null || notice.message === null) return null;
  return (
    <p
      role="status"
      aria-label="Machine maintenance"
      className="min-w-0 text-xs text-destructive-text"
    >
      {notice.message}
    </p>
  );
}
