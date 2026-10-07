import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { useAuthSession } from "@/hooks/queries/user-queries";
import { markAppStarted } from "@/lib/auth-session";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { APP_ROOT_ROUTE_PATH } from "@/lib/route-paths";
import { AuthLayout } from "./AuthLayout";
import { InviteScreen } from "./InviteScreen";
import { LoginScreen } from "./LoginScreen";
import { SignInLinkScreen } from "./SignInLinkScreen";

const JOIN_ROUTE_PATH = "/join";
const SIGN_IN_LINK_ROUTE_PATH = "/signin";

export function AuthGate({ children }: { children: ReactNode }) {
  const session = useAuthSession();
  const location = useLocation();
  const pathname = location.pathname.replace(/\/+$/u, "");
  const token = new URLSearchParams(location.search).get("token") || null;
  const isJoinRoute = pathname === JOIN_ROUTE_PATH;
  const isSignInLinkRoute = pathname === SIGN_IN_LINK_ROUTE_PATH;
  const isSignedIn = (session.data?.user ?? null) !== null;
  const exchangesLink = isSignInLinkRoute && token !== null;
  const showsApp = isSignedIn && !isJoinRoute && !isSignInLinkRoute;
  useEffect(() => {
    if (showsApp) markAppStarted();
  }, [showsApp]);
  if (session.data === undefined) {
    return session.isError ? (
      <AuthLayout
        title="Could not reach bb"
        description={getMutationErrorMessage({
          error: session.error,
          fallbackMessage: "The server did not answer. Try again.",
        })}
      >
        <Button
          variant="outline"
          className="w-full"
          disabled={session.isFetching}
          onClick={() => void session.refetch()}
        >
          Retry
        </Button>
      </AuthLayout>
    ) : null;
  }
  if (exchangesLink && token !== null) {
    return <SignInLinkScreen token={token} isSignedIn={isSignedIn} />;
  }
  if (showsApp) return children;
  if (isSignedIn) return <Navigate to={APP_ROOT_ROUTE_PATH} replace />;
  const identity = session.data.identity ?? null;
  if (isJoinRoute && token !== null) {
    return <InviteScreen token={token} identity={identity} />;
  }
  if (identity === null) return <LoginScreen />;
  const who = identity.name ?? identity.email ?? "your account";
  return (
    <AuthLayout
      title="You are not a member yet"
      description={`You are signed in as ${who}, but this bb server has not invited you. Ask its owner for an invite link, then open it here.`}
    />
  );
}
