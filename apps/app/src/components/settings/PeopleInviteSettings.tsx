import { useState } from "react";
import type { UserRole } from "@bb/domain";
import type { CreatedInviteResponse, UserInvite } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { Label } from "@bb/shared-ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  useCreateUserInvite,
  useRevokeUserInvite,
} from "@/hooks/mutations/user-mutations";
import { useUserInvites } from "@/hooks/queries/user-queries";
import {
  PeopleField,
  ShareLinkField,
  USER_ROLE_LABELS,
  formatExpiry,
} from "./PeopleFormControls";

const INVITE_ROLES: readonly UserRole[] = ["member", "owner"];

function InviteForm({
  onCreated,
}: {
  onCreated: (invite: CreatedInviteResponse) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const createInvite = useCreateUserInvite();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Invite someone</DialogTitle>
        <DialogDescription>
          Creates a one-time link. Whoever opens it chooses their own password.
        </DialogDescription>
      </DialogHeader>
      <form
        className="min-w-0 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (createInvite.isPending) return;
          const trimmedName = name.trim();
          const trimmedEmail = email.trim();
          createInvite.mutate(
            {
              role,
              ...(trimmedName ? { name: trimmedName } : {}),
              ...(trimmedEmail ? { email: trimmedEmail } : {}),
            },
            { onSuccess: onCreated },
          );
        }}
      >
        <PeopleField
          label="Name (optional)"
          name="invite-name"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <PeopleField
          label="Email (optional)"
          type="email"
          name="invite-email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Select
            value={role}
            onValueChange={(value) =>
              setRole(value === "owner" ? "owner" : "member")
            }
          >
            <SelectTrigger aria-label="Role" className="w-full">
              <SelectValue>{USER_ROLE_LABELS[role]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {INVITE_ROLES.map((option) => (
                <SelectItem key={option} value={option}>
                  {USER_ROLE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-snug text-subtle-foreground/75">
            Owners can invite people and manage other members.
          </p>
        </div>
        <DialogFooter>
          <Button type="submit" disabled={createInvite.isPending}>
            Create invite link
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [created, setCreated] = useState<CreatedInviteResponse | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent>
        {created === null ? (
          <InviteForm onCreated={setCreated} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite link ready</DialogTitle>
              <DialogDescription>
                Send this link to {created.name ?? created.email ?? "them"}. It
                is shown only once.
              </DialogDescription>
            </DialogHeader>
            <ShareLinkField
              label="Invite link"
              url={created.url}
              expiresAt={created.expiresAt}
            />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InviteRow({ invite }: { invite: UserInvite }) {
  const revokeInvite = useRevokeUserInvite();
  const title = invite.name ?? invite.email ?? "Open invite";
  return (
    <SettingsRow data-invite-row>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <SettingsBadge>{USER_ROLE_LABELS[invite.role]}</SettingsBadge>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
          {invite.name !== null && invite.email !== null ? (
            <span className="min-w-0 truncate">{invite.email}</span>
          ) : null}
          <span className="shrink-0">
            Expires {formatExpiry(invite.expiresAt)}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        disabled={revokeInvite.isPending}
        aria-label={`Revoke invite for ${title}`}
        onClick={() => revokeInvite.mutate(invite.id)}
      >
        Revoke
      </Button>
    </SettingsRow>
  );
}

export function PeopleInviteSettings() {
  const invites = useUserInvites();
  const [dialog, setDialog] = useState({ id: 0, open: false });
  return (
    <>
      <SettingsSection
        title="Invites"
        description="One-time links that let a new person create an account."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDialog((current) => ({ id: current.id + 1, open: true }))
            }
          >
            <Icon name="UserRoundPlus" className="size-3.5" />
            Invite someone
          </Button>
        }
      >
        {invites.data === undefined ? (
          invites.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Couldn't load invites.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )
        ) : invites.data.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No pending invites.</p>
        ) : (
          <SettingsRowList>
            {invites.data.map((invite) => (
              <InviteRow key={invite.id} invite={invite} />
            ))}
          </SettingsRowList>
        )}
      </SettingsSection>
      <InviteDialog
        key={dialog.id}
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
      />
    </>
  );
}
