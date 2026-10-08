import type { Authenticator, PluginServerApi } from "@bb/plugin";
import {
  findExternalUser,
  findSessionUser,
  patchUser,
} from "@bb/server-kit/db/users";
import {
  authorize,
  sessionCookieName,
  type TrustLookups,
} from "@bb/server-kit/http/trust";
import { actorOf, ownerUser } from "@bb/server-kit/runners/access";
import { findRunnerHost } from "@bb/server-kit/runners/enrollment";
import { publicServerUrl } from "@bb/server-kit/runners/hosts";

export function trustLookups(bb: PluginServerApi): TrustLookups {
  const { db } = bb;
  return {
    allowedHosts: bb.server.allowedHosts,
    sessionCookie: sessionCookieName(bb.server),
    tunnelToken: bb.server.tunnelToken,
    publicUrl: () => publicServerUrl(bb),
    runnerMachine: (token) => findRunnerHost(db, token),
    sessionUser: (token) => findSessionUser(db, token),
    externalUser: (externalId) => findExternalUser(db, externalId),
    rememberAvatar: (userId, avatarUrl) => {
      patchUser(db, userId, { avatarUrl });
      bb.realtime.system(["users-changed"]);
    },
    ownerUser: () => ownerUser(db),
  };
}

export function createAuthenticator(bb: PluginServerApi): Authenticator {
  const lookups = trustLookups(bb);
  return {
    principal: (request) => authorize(request, lookups),
    actor: (principal, threadId) => actorOf(bb, principal, threadId),
    owner() {
      const { id: userId, role } = lookups.ownerUser();
      return { kind: "user", userId, role, implicit: true };
    },
  };
}
