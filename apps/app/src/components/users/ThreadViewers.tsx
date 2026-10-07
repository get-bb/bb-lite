import { useMemo } from "react";
import { useCurrentUser, useUserDirectory } from "@/hooks/queries/user-queries";
import { useThreadViewerIds } from "@/lib/presence";
import { UserAvatarStack } from "./UserAvatar";

interface ThreadViewersProps {
  threadId: string;
  className?: string;
}

function OtherViewers({
  userIds,
  className,
}: {
  userIds: readonly string[];
  className?: string;
}) {
  const directory = useUserDirectory();
  const self = useCurrentUser()?.id;
  const viewers = useMemo(
    () =>
      userIds
        .filter((userId) => userId !== self)
        .flatMap((userId) => directory.get(userId) ?? []),
    [userIds, self, directory],
  );
  return (
    <UserAvatarStack
      users={viewers}
      max={2}
      size="xs"
      label="Viewing now"
      ringClassName="ring-sidebar"
      className={className}
    />
  );
}

export function ThreadViewers({ threadId, className }: ThreadViewersProps) {
  const userIds = useThreadViewerIds(threadId);
  if (userIds.length === 0) return null;
  return <OtherViewers userIds={userIds} className={className} />;
}
