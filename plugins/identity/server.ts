import { server, users, type PluginServerApi } from "@bb/plugin";
import { getUser, listUsers, toUser } from "@bb/server-kit/db/users";
import { createAuthenticator } from "./authenticator.js";
import { registerUserRoutes } from "./routes.js";

export default function identity(bb: PluginServerApi): void {
  const { db } = bb;
  bb.add(server.authenticator, createAuthenticator(bb));
  bb.http.api((app) => registerUserRoutes(app, bb));
  bb.implement(users.current, (_input, { caller }) => {
    const user = caller.user === null ? undefined : getUser(db, caller.user);
    return user === undefined ? null : toUser(user);
  });
  bb.implement(users.list, () => listUsers(db).map(toUser));
}
