import type { Host, User } from "@bb/domain";

type OwnedHost = Pick<Host, "ownerUserId">;
type UserDirectory = ReadonlyMap<string, User>;

export const MACHINE_SHARING_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "shared", label: "Shared" },
] as const satisfies readonly { value: Host["sharing"]; label: string }[];

export function machineSharingDescription(
  sharing: Host["sharing"],
  otherOwnerName: string | null,
): string {
  if (sharing === "private") {
    return otherOwnerName === null
      ? "Only you can start threads and send messages on this machine."
      : `Only ${otherOwnerName} can start threads and send messages on this machine.`;
  }
  return otherOwnerName === null
    ? "Everyone in this bb can start threads and send messages here. Threads run as your OS user, with your files and your provider logins."
    : `Everyone in this bb can start threads and send messages here. Threads run as ${otherOwnerName}'s OS user, with their files and their provider logins.`;
}

export function isHostUsable(host: Pick<Host, "usable">): boolean {
  return host.usable !== false;
}

export function isMachineOwner(host: OwnedHost, user: User | null): boolean {
  return host.ownerUserId !== null && host.ownerUserId === user?.id;
}

export function canManageMachine(host: OwnedHost, user: User | null): boolean {
  if (user === null) return true;
  return user.role === "owner" || isMachineOwner(host, user);
}

export function machineOwnerName(
  host: OwnedHost,
  users: UserDirectory | undefined,
): string | null {
  if (host.ownerUserId === null) return null;
  return users?.get(host.ownerUserId)?.name ?? null;
}

export function privateMachineHint(
  host: Pick<Host, "ownerUserId" | "usable">,
  users: UserDirectory | undefined,
): string | null {
  if (isHostUsable(host)) return null;
  const owner = machineOwnerName(host, users);
  return owner === null ? "Private" : `Private to ${owner}`;
}

export function privateMachineThreadNotice(
  host: OwnedHost,
  users: UserDirectory | undefined,
): string {
  const owner = machineOwnerName(host, users);
  return owner === null
    ? "This thread runs on someone else's private machine. You can read it, but only they can send messages."
    : `This thread runs on ${owner}'s private machine. You can read it, but only they can send messages.`;
}
