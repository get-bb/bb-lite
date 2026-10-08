import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { APP_ROOT_ROUTE_PATH } from "../../lib/route-paths";
import { sdk } from "../../lib/sdk";
import { AuthLayout, AuthSpinner } from "./AuthLayout";
import { useCompleteSignIn } from "./useCompleteSignIn";

export function AuthLinkFailure({
  title,
  message,
  isSignedIn,
}: {
  title: string;
  message: string;
  isSignedIn: boolean;
}) {
  return (
    <AuthLayout title={title} description={message}>
      <Button asChild variant="outline" className="w-full">
        <Link to={APP_ROOT_ROUTE_PATH} replace>
          {isSignedIn ? "Continue to bb" : "Go to sign in"}
        </Link>
      </Button>
    </AuthLayout>
  );
}

export function SignInLinkScreen({
  token,
  isSignedIn,
}: {
  token: string;
  isSignedIn: boolean;
}) {
  const completeSignIn = useCompleteSignIn();
  const exchange = useQuery({
    queryKey: ["auth-sign-in-link", token],
    queryFn: () => sdk.auth.acceptInvite({ token }),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const session = exchange.data;
  useEffect(() => {
    if (session !== undefined) completeSignIn(session);
  }, [completeSignIn, session]);
  if (exchange.isError) {
    return (
      <AuthLinkFailure
        title="Sign-in link not valid"
        message="This sign-in link is invalid or has expired"
        isSignedIn={isSignedIn}
      />
    );
  }
  return (
    <AuthLayout title="Signing you in">
      <AuthSpinner label="Checking your sign-in link…" />
    </AuthLayout>
  );
}
