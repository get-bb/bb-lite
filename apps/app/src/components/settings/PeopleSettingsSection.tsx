import { useState } from "react";
import type { User } from "@bb/domain";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResourceOverflowMenu } from "@bb/shared-ui/resource-list";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { UserAvatar } from "@/components/users/UserAvatar";
import {
  useCreateSignInLink,
  useUpdateUser,
} from "@/hooks/mutations/user-mutations";
import { useCurrentUser, useUsers } from "@/hooks/queries/user-queries";
import { PeopleAccountSettings } from "./PeopleAccountSettings";
import {
  ShareLinkDialog,
  USER_ROLE_LABELS,
  type SharedLink,
} from "./PeopleFormControls";
import { PeopleInviteSettings } from "./PeopleInviteSettings";

function MemberRow({
  user,
  isSelf,
  canManage,
  onSignInLink,
}: {
  user: User;
  isSelf: boolean;
  canManage: boolean;
  onSignInLink: (link: SharedLink) => void;
}) {
  const updateUser = useUpdateUser();
  const createSignInLink = useCreateSignInLink();
  const isDisabled = user.disabledAt !== null;
  const nextRole = user.role === "owner" ? "member" : "owner";
  const busy = updateUser.isPending || createSignInLink.isPending;
  return (
    <SettingsRow data-user-row data-disabled={isDisabled || undefined}>
      <UserAvatar
        user={user}
        size="md"
        showTooltip={false}
        className={cn("size-8 text-xs", isDisabled && "opacity-50 grayscale")}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium",
              isDisabled ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {user.name}
          </span>
          <SettingsBadge>{USER_ROLE_LABELS[user.role]}</SettingsBadge>
          {isSelf ? <SettingsBadge>You</SettingsBadge> : null}
          {isDisabled ? <SettingsBadge>Disabled</SettingsBadge> : null}
        </div>
        <div className="truncate text-xs text-subtle-foreground/75">
          {user.email ?? "No email"}
        </div>
      </div>
      {canManage && !isSelf ? (
        <ResourceOverflowMenu
          label={`${user.name} actions`}
          items={[
            {
              label: `Make ${USER_ROLE_LABELS[nextRole].toLowerCase()}`,
              icon: nextRole === "owner" ? "SecurityCheck" : "UserRound",
              disabled: busy,
              onSelect: () =>
                updateUser.mutate({ userId: user.id, role: nextRole }),
            },
            {
              label: "Create sign-in link",
              icon: "ExternalLink",
              disabled: busy || isDisabled,
              onSelect: () =>
                createSignInLink.mutate(
                  { userId: user.id },
                  {
                    onSuccess: ({ url, expiresAt }) =>
                      onSignInLink({
                        title: `Sign-in link for ${user.name}`,
                        description: `Anyone who opens this link is signed in as ${user.name}. Share it privately.`,
                        url,
                        expiresAt,
                      }),
                  },
                ),
            },
            isDisabled
              ? {
                  label: "Enable",
                  icon: "Check",
                  disabled: busy,
                  onSelect: () =>
                    updateUser.mutate({ userId: user.id, disabled: false }),
                }
              : {
                  label: "Disable",
                  icon: "Lock",
                  tone: "destructive",
                  disabled: busy,
                  onSelect: () =>
                    updateUser.mutate({ userId: user.id, disabled: true }),
                },
          ]}
        />
      ) : null}
    </SettingsRow>
  );
}

function PeopleMembersSettings({ currentUser }: { currentUser: User }) {
  const users = useUsers();
  const [link, setLink] = useState<SharedLink | null>(null);
  return (
    <>
      <SettingsSection
        title="Members"
        description="Everyone who can sign in to this bb server."
      >
        {users.data === undefined ? (
          users.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Couldn't load members.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )
        ) : (
          <SettingsRowList>
            {users.data.map((user) => (
              <MemberRow
                key={user.id}
                user={user}
                isSelf={user.id === currentUser.id}
                canManage={currentUser.role === "owner"}
                onSignInLink={setLink}
              />
            ))}
          </SettingsRowList>
        )}
      </SettingsSection>
      <ShareLinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}

export function PeopleSettingsSection() {
  const currentUser = useCurrentUser();
  if (currentUser === null) return null;
  return (
    <>
      <PeopleAccountSettings user={currentUser} />
      <PeopleMembersSettings currentUser={currentUser} />
      {currentUser.role === "owner" ? <PeopleInviteSettings /> : null}
    </>
  );
}
