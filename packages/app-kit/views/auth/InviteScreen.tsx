import { auth } from "../../lib/client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AuthIdentity, InvitePreviewResponse } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { asHttpError } from "../../lib/http-error";
import { getMutationErrorMessage } from "../../lib/mutation-errors";
import {
  AuthCard,
  AuthError,
  AuthField,
  AuthLayout,
  AuthSpinner,
} from "./AuthLayout";
import { AuthLinkFailure, SignInLinkScreen } from "./SignInLinkScreen";
import { useCompleteSignIn } from "./useCompleteSignIn";

const MIN_PASSWORD_LENGTH = 8;

function describeInviteError(error: unknown): string {
  if (asHttpError(error)?.code === "invite_not_found") {
    return "This invite link is invalid or has expired.";
  }
  return getMutationErrorMessage({
    error,
    fallbackMessage: "Could not create your account.",
  });
}

function inviteDescription(preview: InvitePreviewResponse): string {
  return preview.invitedByName
    ? `${preview.invitedByName} invited you to work together in bb.`
    : "You have been invited to bb.";
}

function IdentityInvite({
  token,
  preview,
  identity,
}: {
  token: string;
  preview: InvitePreviewResponse;
  identity: AuthIdentity;
}) {
  const completeSignIn = useCompleteSignIn();
  const accept = useMutation({
    meta: { showErrorToast: false },
    mutationFn: () => auth.acceptInvite({ token }),
    onSuccess: completeSignIn,
  });
  const who = identity.name ?? identity.email ?? "your account";
  return (
    <AuthLayout title="Join bb" description={inviteDescription(preview)}>
      <AuthCard>
        <div className="space-y-4">
          <p className="text-sm leading-snug text-muted-foreground">
            You are signed in as{" "}
            <span className="font-medium text-foreground">{who}</span>
            {identity.name && identity.email ? ` (${identity.email})` : ""}.
          </p>
          {accept.isError ? (
            <AuthError>{describeInviteError(accept.error)}</AuthError>
          ) : null}
          <Button
            className="w-full"
            disabled={accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? "Joining…" : `Join as ${who}`}
          </Button>
        </div>
      </AuthCard>
    </AuthLayout>
  );
}

function InviteForm({
  token,
  preview,
}: {
  token: string;
  preview: InvitePreviewResponse;
}) {
  const completeSignIn = useCompleteSignIn();
  const [name, setName] = useState(preview.name ?? "");
  const [email, setEmail] = useState(preview.email ?? "");
  const [password, setPassword] = useState("");
  const accept = useMutation({
    meta: { showErrorToast: false },
    mutationFn: () =>
      auth.acceptInvite({
        token,
        name: name.trim(),
        email: email.trim(),
        password,
      }),
    onSuccess: completeSignIn,
  });
  return (
    <AuthLayout title="Join bb" description={inviteDescription(preview)}>
      <AuthCard>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!accept.isPending) accept.mutate();
          }}
        >
          <AuthField
            label="Name"
            name="name"
            autoComplete="name"
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <AuthField
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <AuthField
            label="Password"
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {accept.isError ? (
            <AuthError>{describeInviteError(accept.error)}</AuthError>
          ) : null}
          <Button type="submit" className="w-full" disabled={accept.isPending}>
            {accept.isPending ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </AuthCard>
      <p className="text-center text-xs text-subtle-foreground">
        This invite expires{" "}
        {new Date(preview.expiresAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
        .
      </p>
    </AuthLayout>
  );
}

export function InviteScreen({
  token,
  identity = null,
}: {
  token: string;
  identity?: AuthIdentity | null;
}) {
  const preview = useQuery({
    queryKey: ["auth-invite-preview", token],
    queryFn: () => auth.invite(token),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (preview.isError) {
    return asHttpError(preview.error)?.status === 404 ? (
      <AuthLinkFailure
        title="Invite not valid"
        message="This invite link is invalid or has expired."
        isSignedIn={false}
      />
    ) : (
      <AuthLayout
        title="Could not load invite"
        description={getMutationErrorMessage({
          error: preview.error,
          fallbackMessage: "Something went wrong.",
        })}
      >
        <Button
          variant="outline"
          className="w-full"
          onClick={() => void preview.refetch()}
        >
          Retry
        </Button>
      </AuthLayout>
    );
  }
  if (preview.data === undefined) {
    return (
      <AuthLayout title="Join bb">
        <AuthSpinner label="Loading your invite…" />
      </AuthLayout>
    );
  }
  if (preview.data.kind === "sign-in") {
    return <SignInLinkScreen token={token} isSignedIn={false} />;
  }
  return identity === null ? (
    <InviteForm token={token} preview={preview.data} />
  ) : (
    <IdentityInvite token={token} preview={preview.data} identity={identity} />
  );
}
