import type { AuthSessionResponse } from "@bb/server-contract";
import { qk } from "../hooks/queries/query-keys";
import { appQueryClient } from "./app-query-client";
import { auth, setUnauthenticatedHandler } from "./client";

const SIGNED_OUT: AuthSessionResponse = { user: null };

let appStarted = false;

export function markAppStarted(): void {
  appStarted = true;
}

export function hasAppStarted(): boolean {
  return appStarted;
}

export function setAuthSession(session: AuthSessionResponse): void {
  appQueryClient.setQueryData(qk.authSession(), session);
}

export async function signOut(): Promise<AuthSessionResponse> {
  await auth.logout();
  const session = await auth.session().catch(() => SIGNED_OUT);
  setAuthSession(session);
  return session;
}

export function installUnauthenticatedHandler(): void {
  setUnauthenticatedHandler(() => setAuthSession(SIGNED_OUT));
}
