import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { AuthSessionResponse } from "@bb/server-contract";
import { hasAppStarted, setAuthSession } from "../../lib/auth-session";
import { APP_ROOT_ROUTE_PATH } from "../../lib/route-paths";

export function useCompleteSignIn(): (session: AuthSessionResponse) => void {
  const navigate = useNavigate();
  return useCallback(
    (session) => {
      if (hasAppStarted()) {
        window.location.replace(APP_ROOT_ROUTE_PATH);
        return;
      }
      setAuthSession(session);
      void navigate(APP_ROOT_ROUTE_PATH, { replace: true });
    },
    [navigate],
  );
}
