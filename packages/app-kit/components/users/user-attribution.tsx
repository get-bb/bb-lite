import { useCallback, useMemo } from "react";
import type { User } from "@bb/domain";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useCurrentUser,
  useIsMultiUser,
  useUserDirectory,
} from "../../hooks/queries/user-queries";
import { useOnlineUsers } from "../../lib/presence";
import { UserAvatar } from "./UserAvatar";

export interface UserAttribution {
  user: User;
  isSelf: boolean;
}

export type UserAttributionLookup = (
  userId: string | null | undefined,
) => UserAttribution | null;

export function useUserAttributionLookup(): UserAttributionLookup {
  const isMultiUser = useIsMultiUser();
  const directory = useUserDirectory();
  const selfId = useCurrentUser()?.id ?? null;
  return useCallback(
    (userId) => {
      if (!isMultiUser || !userId) return null;
      const user = directory.get(userId);
      return user ? { user, isSelf: user.id === selfId } : null;
    },
    [directory, isMultiUser, selfId],
  );
}

export function useUserAttribution(
  userId: string | null | undefined,
): UserAttribution | null {
  const lookup = useUserAttributionLookup();
  return useMemo(() => lookup(userId), [lookup, userId]);
}

export function useOtherOnlineUsers(): User[] {
  const online = useOnlineUsers();
  const selfId = useCurrentUser()?.id ?? null;
  return useMemo(
    () => online.filter((user) => user.id !== selfId),
    [online, selfId],
  );
}

export function UserAttributionLabel({
  attribution,
  className,
}: {
  attribution: UserAttribution;
  className?: string;
}) {
  return (
    <span
      data-user-attribution={attribution.user.id}
      title={attribution.user.name}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs leading-none text-muted-foreground",
        className,
      )}
    >
      <UserAvatar user={attribution.user} size="xs" showTooltip={false} />
      <span className="min-w-0 truncate">
        {attribution.isSelf ? "You" : attribution.user.name}
      </span>
    </span>
  );
}
