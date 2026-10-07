import type * as domain from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import type { Http } from "../http.js";

type Abortable = { signal?: AbortSignal };
type UserTarget = { userId: string };

export interface AuthArea {
  session(args?: Abortable): Promise<api.AuthSessionResponse>;
  login(args: api.LoginRequest): Promise<api.AuthSessionResponse>;
  logout(): Promise<{ ok: true }>;
  invite(args: { token: string }): Promise<api.InvitePreviewResponse>;
  acceptInvite(
    args: api.AcceptInviteRequest & { token: string },
  ): Promise<api.AuthSessionResponse>;
}

export interface UsersArea {
  list(args?: Abortable): Promise<domain.User[]>;
  update(args: api.UpdateUserRequest & UserTarget): Promise<domain.User>;
  setPassword(args: api.SetPasswordRequest & UserTarget): Promise<domain.User>;
  createSignInLink(args: UserTarget): Promise<api.SignInLinkResponse>;
  invites(args?: Abortable): Promise<api.UserInvite[]>;
  createInvite(
    args?: api.CreateInviteRequest,
  ): Promise<api.CreatedInviteResponse>;
  revokeInvite(args: { inviteId: string }): Promise<{ ok: true }>;
  presence(args?: Abortable): Promise<api.PresenceResponse>;
}

export function createAuthArea(http: Http): AuthArea {
  const routes = publicApiRoutes.auth;
  return {
    session: (args) => http.json(routes.session, {}, args?.signal),
    login: (json) => http.json(routes.login, { json }),
    logout: () => http.json(routes.logout, {}),
    invite: ({ token }) => http.json(routes.invite, { param: { token } }),
    acceptInvite: ({ token, ...json }) =>
      http.json(routes.acceptInvite, { param: { token }, json }),
  };
}

export function createUsersArea(http: Http): UsersArea {
  const routes = publicApiRoutes.users;
  const at = (id: string) => ({ param: { id } });
  return {
    list: (args) => http.json(routes.list, {}, args?.signal),
    update: ({ userId, ...json }) =>
      http.json(routes.update, { ...at(userId), json }),
    setPassword: ({ userId, ...json }) =>
      http.json(routes.setPassword, { ...at(userId), json }),
    createSignInLink: ({ userId }) =>
      http.json(routes.createSignInLink, at(userId)),
    invites: (args) => http.json(routes.invites, {}, args?.signal),
    createInvite: (json = {}) => http.json(routes.createInvite, { json }),
    revokeInvite: ({ inviteId }) =>
      http.json(routes.revokeInvite, at(inviteId)),
    presence: (args) => http.json(routes.presence, {}, args?.signal),
  };
}
