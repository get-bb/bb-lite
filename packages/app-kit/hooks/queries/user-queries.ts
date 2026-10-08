import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { User } from "@bb/domain";
import { sdk } from "../../lib/sdk";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

const NO_USERS: readonly User[] = [];

export function useAuthSession() {
  return useQuery({
    queryKey: qk.authSession(),
    queryFn: ({ signal }) => sdk.auth.session({ signal }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCurrentUser(): User | null {
  return useAuthSession().data?.user ?? null;
}

export function useUsers(options?: QueryOptions) {
  return useQuery({
    queryKey: qk.users(),
    queryFn: ({ signal }) => sdk.users.list({ signal }),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useUserDirectory(): ReadonlyMap<string, User> {
  const users = useUsers().data ?? NO_USERS;
  return useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
}

export function useIsMultiUser(): boolean {
  const users = useUsers().data ?? NO_USERS;
  return users.filter((user) => user.disabledAt === null).length > 1;
}

export function useUserInvites(options?: QueryOptions) {
  return useQuery({
    queryKey: qk.userInvites(),
    queryFn: ({ signal }) => sdk.users.invites({ signal }),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function userInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const [first = "?", second] = words;
  const letters = second ? `${first[0]}${second[0]}` : first.slice(0, 2);
  return letters.toUpperCase();
}

export function userHue(userId: string): number {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}
