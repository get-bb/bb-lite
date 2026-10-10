import { users, type PluginServerApi } from "@bb/plugin";
import type { User } from "@bb/domain";
import {
  acceptInviteRequestSchema,
  loginRequestSchema,
} from "@bb/server-contract";
import { hashPassword, verifyPassword } from "@bb/server-kit/auth/passwords";
import * as store from "@bb/server-kit/db/users";
import { publicServerUrl } from "@bb/server-kit/runners/hosts";
import { readJsonBody, type ApiApp } from "@bb/server-kit/http/api";
import {
  ApiError,
  forbidden,
  invalidRequest,
} from "@bb/server-kit/http/errors";
import {
  principalOf,
  requestCookie,
  requestOrigin,
  requireOwner,
  requireUser,
  senderOrigin,
  sessionCookieName,
} from "@bb/server-kit/http/trust";

interface RequestContext {
  req: {
    url: string;
    header(name: string): string | undefined;
  };
  header(name: string, value: string): void;
}

interface Attempts {
  failures: number;
  resetAt: number;
}

const OK = { ok: true } as const;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 10;

function inviteNotFound() {
  return new ApiError(
    404,
    "invite_not_found",
    "This link is unknown, already used or expired.",
  );
}

function emailTaken() {
  const message = "Another account already uses this email";
  return new ApiError(409, "email_taken", message);
}

export function createIdentity(bb: PluginServerApi): (app: ApiApp) => void {
  const { db, realtime: hub } = bb;
  const cookieName = sessionCookieName(bb.server);
  const attempts = new Map<string, Attempts>();

  const setCookie = (c: RequestContext, value: string, maxAge: number) => {
    const forwarded = c.req.header("x-forwarded-proto");
    const secure =
      forwarded === "https" || new URL(c.req.url).protocol === "https:";
    const attributes = [
      `${cookieName}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
      ...(secure ? ["Secure"] : []),
    ];
    c.header("set-cookie", attributes.join("; "));
  };

  const signIn = (c: RequestContext, user: store.UserRow) => {
    const { token, maxAgeSeconds } = store.createSession(db, user.id);
    setCookie(c, token, maxAgeSeconds);
    return { user: store.toUser(user) };
  };

  const linkBase = () =>
    publicServerUrl(bb) ?? senderOrigin() ?? requestOrigin() ?? bb.server.url;

  const throttled = (email: string) => {
    const entry = attempts.get(email);
    if (entry === undefined || entry.resetAt <= bb.now()) return false;
    return entry.failures >= LOGIN_MAX_FAILURES;
  };

  const recordFailure = (email: string) => {
    const entry = attempts.get(email);
    const live = entry !== undefined && entry.resetAt > bb.now();
    const failures = live ? entry.failures + 1 : 1;
    const resetAt = live ? entry.resetAt : bb.now() + LOGIN_WINDOW_MS;
    attempts.set(email, { failures, resetAt });
  };

  const changed = () => hub.system(["users-changed"]);

  const assertNotLastOwner = (target: store.UserRow) => {
    const active = target.role === "owner" && target.disabledAt === null;
    if (!active || store.countActiveOwners(db) > 1) return;
    const message = "This bb needs at least one active owner";
    throw new ApiError(409, "last_owner", message);
  };

  const assertEmailFree = (email: string, exceptUserId: string | null) => {
    const holder = store.findUserByEmail(db, email);
    if (holder !== undefined && holder.id !== exceptUserId) throw emailTaken();
  };

  bb.implement(users.list, () => store.listUsers(db).map(store.toUser));

  bb.implement(users.update, ({ userId, ...payload }) => {
    const principal = requireUser();
    const target = store.requireUser(db, userId);
    const self = principal.userId === target.id;
    const owner = principal.role === "owner";
    if (!self && !owner) throw forbidden("Only an owner can edit other users");
    const { name, email, role, disabled } = payload;
    const administrative = role !== undefined || disabled !== undefined;
    if (administrative && !owner) {
      throw forbidden("Only an owner can change roles or disable users");
    }
    const demoted = role === "member" || disabled === true;
    const updated = db.transaction(() => {
      if (demoted) assertNotLastOwner(target);
      if (email != null) assertEmailFree(email, target.id);
      const disabledAt =
        disabled === undefined ? undefined : disabled ? bb.now() : null;
      if (disabled === true) store.deleteUserSessions(db, target.id);
      return store.patchUser(db, target.id, { name, email, role, disabledAt });
    });
    changed();
    return store.toUser(updated);
  });

  bb.implement(users.setPassword, async (input) => {
    const { userId, password, currentPassword } = input;
    const principal = requireUser();
    const target = store.requireUser(db, userId);
    if (principal.userId !== target.id) {
      throw forbidden("You can only set your own password");
    }
    if (target.email === null) {
      throw new ApiError(
        409,
        "email_required",
        "Add an email first: it is what you sign in with",
      );
    }
    if (target.passwordHash !== null) {
      const current = currentPassword ?? "";
      if (!(await verifyPassword(current, target.passwordHash))) {
        throw forbidden("Current password is wrong");
      }
    }
    const passwordHash = await hashPassword(password);
    const updated = store.patchUser(db, target.id, { passwordHash });
    changed();
    return store.toUser(updated);
  });

  bb.implement(users.createSignInLink, ({ userId }) => {
    const principal = requireUser();
    const target = store.requireUser(db, userId);
    if (principal.userId !== target.id && principal.role !== "owner") {
      throw forbidden("Only an owner can create sign-in links for others");
    }
    if (target.disabledAt !== null) {
      throw new ApiError(409, "user_disabled", "This user is disabled");
    }
    const { row, token } = store.createInvite(db, {
      kind: "sign-in",
      userId: target.id,
      name: null,
      email: null,
      role: target.role,
      createdByUserId: principal.userId,
    });
    const url = `${linkBase()}/signin?token=${token}`;
    return { url, expiresAt: row.expiresAt };
  });

  bb.implement(users.listInvites, () => {
    requireOwner("Only an owner can see invites");
    return store.listPendingInvites(db).map(store.toUserInvite);
  });

  bb.implement(users.createInvite, (payload) => {
    requireOwner("Only an owner can invite people");
    const { userId } = requireUser();
    const { name = null, email = null, role = "member" } = payload;
    if (email !== null) assertEmailFree(email, null);
    const { row, token } = store.createInvite(db, {
      kind: "invite",
      userId: null,
      name,
      email,
      role,
      createdByUserId: userId,
    });
    changed();
    const url = `${linkBase()}/join?token=${token}`;
    return { ...store.toUserInvite(row), url };
  });

  bb.implement(users.deleteInvite, ({ inviteId }) => {
    requireOwner("Only an owner can revoke invites");
    if (!store.deleteInvite(db, inviteId)) throw inviteNotFound();
    changed();
  });

  bb.implement(users.presence, () => ({ users: hub.presence() }));

  return (app) => {
    app.get("/auth/session", (c) => {
      const principal = principalOf(c);
      const row =
        principal.kind === "user"
          ? store.getUser(db, principal.userId)
          : undefined;
      const user: User | null = row === undefined ? null : store.toUser(row);
      const visitor =
        principal.kind === "anonymous" ? principal.identity : null;
      if (visitor == null) return c.json({ user });
      const { name, email, avatarUrl } = visitor;
      return c.json({ user, identity: { name, email, avatarUrl } });
    });

    app.post("/auth/login", async (c) => {
      const { email, password } = await readJsonBody(c, loginRequestSchema);
      if (throttled(email)) {
        const message =
          "Too many sign-in attempts. Try again in a few minutes.";
        throw new ApiError(429, "too_many_attempts", message);
      }
      const user = store.findUserByEmail(db, email);
      const valid = await verifyPassword(password, user?.passwordHash ?? null);
      if (user === undefined || !valid || user.disabledAt !== null) {
        recordFailure(email);
        const message = "Wrong email or password";
        throw new ApiError(401, "invalid_credentials", message);
      }
      attempts.delete(email);
      return c.json(signIn(c, user));
    });

    app.post("/auth/logout", (c) => {
      const cookie = c.req.header("cookie");
      const token = requestCookie({ headers: { cookie } }, cookieName);
      if (token !== undefined) store.deleteSession(db, token);
      setCookie(c, "", 0);
      return c.json(OK);
    });

    app.get("/auth/invites/:token", (c) => {
      const invite = store.findUsableInvite(db, c.req.param("token"));
      if (invite === undefined) throw inviteNotFound();
      const { kind, name, email, expiresAt, createdByUserId } = invite;
      const inviter =
        createdByUserId === null
          ? undefined
          : store.getUser(db, createdByUserId);
      const invitedByName = inviter?.name ?? null;
      return c.json({ kind, name, email, invitedByName, expiresAt });
    });

    app.post("/auth/invites/:token/accept", async (c) => {
      const body = await readJsonBody(c, acceptInviteRequestSchema);
      const invite = store.findUsableInvite(db, c.req.param("token"));
      if (invite === undefined) throw inviteNotFound();
      const principal = principalOf(c);
      const visitor =
        principal.kind === "anonymous" ? principal.identity : null;
      const externalId = visitor?.id;
      if (invite.kind === "sign-in") {
        const user =
          invite.userId === null ? undefined : store.getUser(db, invite.userId);
        if (user === undefined || user.disabledAt !== null) {
          throw inviteNotFound();
        }
        if (!store.consumeInvite(db, invite.id)) throw inviteNotFound();
        if (externalId === undefined || user.externalId !== null) {
          return c.json(signIn(c, user));
        }
        const avatarUrl = visitor?.avatarUrl ?? undefined;
        const linked = store.patchUser(db, user.id, { externalId, avatarUrl });
        changed();
        return c.json({ user: store.toUser(linked) });
      }
      const name = body.name ?? visitor?.name ?? visitor?.email?.split("@")[0];
      const email = body.email ?? visitor?.email ?? undefined;
      const { password } = body;
      const identified = externalId !== undefined || password !== undefined;
      const reachable = email !== undefined || externalId !== undefined;
      if (name == null || !reachable || !identified) {
        throw invalidRequest("An invite needs a name, an email and a password");
      }
      const passwordHash =
        password === undefined ? null : await hashPassword(password);
      const user = db.transaction(() => {
        if (email !== undefined) assertEmailFree(email, null);
        if (!store.consumeInvite(db, invite.id)) throw inviteNotFound();
        const contact = { name, email: email ?? null };
        const account = { ...contact, role: invite.role, passwordHash };
        const avatarUrl = visitor?.avatarUrl ?? null;
        return store.insertUser(db, { ...account, externalId, avatarUrl });
      });
      changed();
      if (externalId !== undefined) return c.json({ user: store.toUser(user) });
      return c.json(signIn(c, user));
    });
  };
}
