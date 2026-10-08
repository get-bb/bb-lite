import { createHash, randomBytes } from "node:crypto";
import type { User, UserRole } from "@bb/domain";
import type { UserInvite } from "@bb/server-contract";
import { ApiError } from "../http/errors.js";
import {
  insertRow,
  newId,
  updateRow,
  type Db,
  type RowValues,
} from "./index.js";

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  passwordHash: string | null;
  externalId: string | null;
  avatarUrl: string | null;
  disabledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InviteRow {
  id: string;
  kind: "invite" | "sign-in";
  userId: string | null;
  name: string | null;
  email: string | null;
  role: UserRole;
  createdByUserId: string | null;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

type NewUser = Pick<UserRow, "name" | "email" | "role" | "passwordHash"> &
  Partial<Pick<UserRow, "externalId" | "avatarUrl">>;
type NewInvite = Pick<
  InviteRow,
  "kind" | "userId" | "name" | "email" | "role" | "createdByUserId"
>;

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
const SESSION_TOUCH_MS = 60 * 60_000;
const INVITE_TTL_MS: Record<InviteRow["kind"], number> = {
  invite: 7 * 24 * 60 * 60_000,
  "sign-in": 15 * 60_000,
};

function mintToken(prefix: "bbs" | "bbi") {
  return `${prefix}_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function toUser(row: UserRow): User {
  const { passwordHash, externalId: _externalId, ...user } = row;
  return { ...user, hasPassword: passwordHash !== null };
}

export function getUser(db: Db, id: string): UserRow | undefined {
  return db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export function requireUser(db: Db, id: string): UserRow {
  const user = getUser(db, id);
  if (user !== undefined) return user;
  throw new ApiError(404, "user_not_found", "User not found");
}

export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.get<UserRow>("SELECT * FROM users WHERE email = ?", email);
}

export function findExternalUser(
  db: Db,
  externalId: string,
): UserRow | undefined {
  return db.get<UserRow>(
    "SELECT * FROM users WHERE external_id = ? AND disabled_at IS NULL",
    externalId,
  );
}

export function listUsers(db: Db): UserRow[] {
  return db.all<UserRow>("SELECT * FROM users ORDER BY rowid");
}

export function countActiveOwners(db: Db): number {
  const row = db.get<{ owners: number }>(
    `SELECT COUNT(*) AS owners FROM users
     WHERE role = 'owner' AND disabled_at IS NULL`,
  );
  return row?.owners ?? 0;
}

export function insertUser(db: Db, user: NewUser): UserRow {
  const id = newId("usr");
  const at = { createdAt: db.now(), updatedAt: db.now() };
  insertRow(db, "users", { ...user, id, ...at });
  return requireUser(db, id);
}

export function patchUser(db: Db, id: string, patch: RowValues): UserRow {
  updateRow(db, "users", id, patch);
  return requireUser(db, id);
}

export function createSession(db: Db, userId: string) {
  const token = mintToken("bbs");
  const now = db.now();
  const expiresAt = now + SESSION_TTL_MS;
  insertRow(db, "user_sessions", {
    id: newId("uses"),
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    lastSeenAt: now,
    createdAt: now,
  });
  return { token, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000) };
}

export function findSessionUser(db: Db, token: string): UserRow | undefined {
  const tokenHash = hashToken(token);
  const session = db.get<{ id: string; userId: string; lastSeenAt: number }>(
    `SELECT id, user_id, last_seen_at FROM user_sessions
     WHERE token_hash = ? AND expires_at > ?`,
    tokenHash,
    db.now(),
  );
  if (session === undefined) return undefined;
  const user = getUser(db, session.userId);
  if (user === undefined || user.disabledAt !== null) return undefined;
  if (db.now() - session.lastSeenAt > SESSION_TOUCH_MS) {
    const sql = "UPDATE user_sessions SET last_seen_at = ? WHERE id = ?";
    db.run(sql, db.now(), session.id);
  }
  return user;
}

export function deleteSession(db: Db, token: string): void {
  db.run("DELETE FROM user_sessions WHERE token_hash = ?", hashToken(token));
}

export function deleteUserSessions(db: Db, userId: string): void {
  db.run("DELETE FROM user_sessions WHERE user_id = ?", userId);
}

export function createInvite(db: Db, invite: NewInvite) {
  const token = mintToken("bbi");
  const id = newId("uinv");
  const now = db.now();
  const expiresAt = now + INVITE_TTL_MS[invite.kind];
  const stored = { ...invite, id, tokenHash: hashToken(token) };
  insertRow(db, "user_invites", { ...stored, expiresAt, createdAt: now });
  const row = db.get<InviteRow>("SELECT * FROM user_invites WHERE id = ?", id);
  if (row === undefined) throw new Error("Invite insert was lost");
  return { row, token };
}

export function findUsableInvite(db: Db, token: string): InviteRow | undefined {
  return db.get<InviteRow>(
    `SELECT * FROM user_invites
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    hashToken(token),
    db.now(),
  );
}

export function consumeInvite(db: Db, id: string): boolean {
  const sql = `UPDATE user_invites SET used_at = ?
    WHERE id = ? AND used_at IS NULL`;
  return db.run(sql, db.now(), id).changes === 1;
}

export function listPendingInvites(db: Db): InviteRow[] {
  return db.all<InviteRow>(
    `SELECT * FROM user_invites
     WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ?
     ORDER BY created_at, id`,
    db.now(),
  );
}

export function deleteInvite(db: Db, id: string): boolean {
  const sql = "DELETE FROM user_invites WHERE id = ? AND kind = 'invite'";
  return db.run(sql, id).changes === 1;
}

export function toUserInvite(row: InviteRow): UserInvite {
  const { id, name, email, role, createdByUserId, expiresAt, createdAt } = row;
  return { id, name, email, role, createdByUserId, expiresAt, createdAt };
}
