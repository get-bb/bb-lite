import { useState } from "react";
import type { User } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { SettingsSection, SettingsWithControl } from "../ui/settings-section";
import {
  useCreateSignInLink,
  useSetUserPassword,
  useSignOut,
  useUpdateUser,
} from "../../hooks/mutations/user-mutations";
import {
  PeopleField,
  ShareLinkDialog,
  type SharedLink,
} from "./PeopleFormControls";

const MIN_PASSWORD_LENGTH = 8;
const ACCOUNT_BLOCK_CLASS = "py-3.5 first:pt-0 last:pb-0";

function ProfileForm({ user }: { user: User }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? "");
  const updateUser = useUpdateUser("Failed to update your account.");
  const nextName = name.trim();
  const nextEmail = email.trim() === "" ? null : email.trim();
  const nameChanged = nextName !== user.name;
  const emailChanged = nextEmail !== user.email;
  return (
    <form
      className={`space-y-3 ${ACCOUNT_BLOCK_CLASS}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (updateUser.isPending || nextName === "") return;
        updateUser.mutate(
          {
            userId: user.id,
            ...(nameChanged ? { name: nextName } : {}),
            ...(emailChanged ? { email: nextEmail } : {}),
          },
          { onSuccess: () => appToast.success("Account updated") },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <PeopleField
          label="Name"
          name="name"
          autoComplete="name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <PeopleField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={
            updateUser.isPending ||
            nextName === "" ||
            (!nameChanged && !emailChanged)
          }
        >
          Save
        </Button>
      </div>
    </form>
  );
}

function PasswordForm({ user }: { user: User }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const setUserPassword = useSetUserPassword();
  return (
    <form
      className={`space-y-3 ${ACCOUNT_BLOCK_CLASS}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (setUserPassword.isPending) return;
        setUserPassword.mutate(
          {
            userId: user.id,
            password,
            ...(user.hasPassword ? { currentPassword } : {}),
          },
          {
            onSuccess: () => {
              setCurrentPassword("");
              setPassword("");
              appToast.success("Password updated");
            },
          },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {user.hasPassword ? (
          <PeopleField
            label="Current password"
            type="password"
            name="current-password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        ) : null}
        <PeopleField
          label={user.hasPassword ? "New password" : "Password"}
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {user.hasPassword || user.email !== null ? null : (
        <p className="text-xs leading-snug text-subtle-foreground/75">
          Add an email above to sign in with this password from other devices.
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={
            setUserPassword.isPending ||
            password.length < MIN_PASSWORD_LENGTH ||
            (user.hasPassword && currentPassword === "")
          }
        >
          {user.hasPassword ? "Change password" : "Set password"}
        </Button>
      </div>
    </form>
  );
}

export function PeopleAccountSettings({ user }: { user: User }) {
  const [link, setLink] = useState<SharedLink | null>(null);
  const createSignInLink = useCreateSignInLink();
  const signOut = useSignOut();
  return (
    <>
      <SettingsSection
        title="Your account"
        description="How you appear to teammates and how you sign in."
        bodyClassName="divide-y divide-border"
      >
        <ProfileForm key={user.updatedAt} user={user} />
        <PasswordForm user={user} />
        <div className={ACCOUNT_BLOCK_CLASS}>
          <SettingsWithControl
            label="Sign in on another device"
            description="Create a one-time link that signs a browser in as you."
          >
            <Button
              variant="outline"
              size="sm"
              disabled={createSignInLink.isPending}
              onClick={() =>
                createSignInLink.mutate(
                  { userId: user.id },
                  {
                    onSuccess: ({ url, expiresAt }) =>
                      setLink({
                        title: "Your sign-in link",
                        description:
                          "Open this link on the device you want to sign in on.",
                        url,
                        expiresAt,
                      }),
                  },
                )
              }
            >
              Create sign-in link
            </Button>
          </SettingsWithControl>
        </div>
        <div className={ACCOUNT_BLOCK_CLASS}>
          <SettingsWithControl
            label="Sign out"
            description="End your session in this browser."
          >
            <Button
              variant="outline"
              size="sm"
              disabled={signOut.isPending}
              onClick={() =>
                signOut.mutate(undefined, {
                  onSuccess: (session) => {
                    if (session.user === null) return;
                    appToast.success("Still signed in", {
                      description:
                        "This browser is on the server machine, which is always signed in.",
                    });
                  },
                })
              }
            >
              Sign out
            </Button>
          </SettingsWithControl>
        </div>
      </SettingsSection>
      <ShareLinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}
