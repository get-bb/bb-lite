import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { asHttpError } from "../../lib/http-error";
import { getMutationErrorMessage } from "../../lib/mutation-errors";
import { sdk } from "../../lib/sdk";
import { AuthCard, AuthError, AuthField, AuthLayout } from "./AuthLayout";
import { useCompleteSignIn } from "./useCompleteSignIn";

function describeLoginError(error: unknown): string {
  const httpError = asHttpError(error);
  if (httpError?.code === "invalid_credentials" || httpError?.status === 401) {
    return "Incorrect email or password.";
  }
  return getMutationErrorMessage({
    error,
    fallbackMessage: "Could not sign in.",
  });
}

export function LoginScreen() {
  const completeSignIn = useCompleteSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    meta: { showErrorToast: false },
    mutationFn: () => sdk.auth.login({ email: email.trim(), password }),
    onSuccess: completeSignIn,
  });
  return (
    <AuthLayout title="Sign in to bb">
      <AuthCard>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!login.isPending) login.mutate();
          }}
        >
          <AuthField
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <AuthField
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {login.isError ? (
            <AuthError>{describeLoginError(login.error)}</AuthError>
          ) : null}
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </AuthCard>
      <p className="text-center text-xs leading-relaxed text-subtle-foreground">
        No account? Ask a teammate for an invite link. On the server machine you
        can run{" "}
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
          bb user sign-in-link
        </code>
        .
      </p>
    </AuthLayout>
  );
}
