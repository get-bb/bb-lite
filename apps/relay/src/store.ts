import { newId, newToken, newUserCode, sha256Hex } from "./crypto.js";

export interface User {
  id: string;
  github_id: number;
  login: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
  can_host: number;
  created_at: number;
}

export type GithubProfile = Pick<
  User,
  "github_id" | "login" | "name" | "email" | "avatar_url"
>;

export interface Server {
  id: string;
  user_id: string;
  label: string;
  credential_hash: string | null;
  client_name: string | null;
  last_seen_at: number | null;
  created_at: number;
}

export interface LinkCode {
  device_code_hash: string;
  user_code: string;
  client_name: string;
  status: "pending" | "approved" | "denied" | "delivered";
  server_id: string | null;
  credential: string | null;
  polled_at: number | null;
  expires_at: number;
}

export interface Machine {
  id: string;
  server_id: string;
}

type Value = string | number | null;

const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
const LINK_TTL_MS = 10 * 60_000;
const MACHINE_CODE_TTL_MS = 10 * 60_000;
export const MACHINE_LIMIT = 50;
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1_000;

function one<Row>(db: D1Database, sql: string, ...values: Value[]) {
  return db
    .prepare(sql)
    .bind(...values)
    .first<Row>();
}

async function all<Row>(db: D1Database, sql: string, ...values: Value[]) {
  const { results } = await db
    .prepare(sql)
    .bind(...values)
    .all<Row>();
  return results;
}

async function run(db: D1Database, sql: string, ...values: Value[]) {
  const { meta } = await db
    .prepare(sql)
    .bind(...values)
    .run();
  return meta.changes;
}

export function userById(db: D1Database, id: string) {
  return one<User>(db, "SELECT * FROM users WHERE id = ?", id);
}

export function listUsers(db: D1Database) {
  return all<User>(db, "SELECT * FROM users ORDER BY created_at, id");
}

export async function upsertGithubUser(
  db: D1Database,
  profile: GithubProfile,
): Promise<User | null> {
  const { github_id: githubId, login, name, email } = profile;
  await run(
    db,
    `INSERT INTO users
       (id, github_id, login, name, email, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET login = excluded.login,
       name = excluded.name, email = excluded.email,
       avatar_url = excluded.avatar_url`,
    newId("ru"),
    githubId,
    login,
    name,
    email,
    profile.avatar_url,
    Date.now(),
  );
  return one<User>(db, "SELECT * FROM users WHERE github_id = ?", githubId);
}

export function setCanHost(db: D1Database, userId: string, allowed: boolean) {
  const sql = "UPDATE users SET can_host = ? WHERE id = ?";
  return run(db, sql, allowed ? 1 : 0, userId);
}

export async function createSession(db: D1Database, userId: string) {
  const token = newToken("bbrs");
  const now = Date.now();
  await run(
    db,
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
    await sha256Hex(token),
    userId,
    now + SESSION_TTL_MS,
    now,
  );
  return token;
}

export async function sessionUser(db: D1Database, token: string) {
  return one<User>(
    db,
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
    await sha256Hex(token),
    Date.now(),
  );
}

export async function deleteSession(db: D1Database, token: string) {
  const sql = "DELETE FROM sessions WHERE token_hash = ?";
  await run(db, sql, await sha256Hex(token));
}

export function serverByLabel(db: D1Database, label: string) {
  return one<Server>(db, "SELECT * FROM servers WHERE label = ?", label);
}

export async function serverByCredential(db: D1Database, credential: string) {
  const sql = "SELECT * FROM servers WHERE credential_hash = ?";
  return one<Server>(db, sql, await sha256Hex(credential));
}

export function serversOf(db: D1Database, userId: string) {
  const sql = "SELECT * FROM servers WHERE user_id = ? ORDER BY label";
  return all<Server>(db, sql, userId);
}

export function touchServer(db: D1Database, id: string) {
  const sql = "UPDATE servers SET last_seen_at = ? WHERE id = ?";
  return run(db, sql, Date.now(), id);
}

export function clearServerCredential(db: D1Database, id: string) {
  const sql = "UPDATE servers SET credential_hash = NULL WHERE id = ?";
  return run(db, sql, id);
}

export async function startLink(db: D1Database, clientName: string) {
  const deviceCode = newToken("bbd");
  const userCode = newUserCode();
  const now = Date.now();
  const expiresAt = now + LINK_TTL_MS;
  await run(
    db,
    `INSERT INTO link_codes
       (device_code_hash, user_code, client_name, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    await sha256Hex(deviceCode),
    userCode,
    clientName,
    expiresAt,
    now,
  );
  return { deviceCode, userCode, expiresAt };
}

export function linkByUserCode(db: D1Database, userCode: string) {
  const sql = "SELECT * FROM link_codes WHERE user_code = ?";
  return one<LinkCode>(db, sql, userCode);
}

export async function linkByDeviceCode(db: D1Database, deviceCode: string) {
  const sql = "SELECT * FROM link_codes WHERE device_code_hash = ?";
  return one<LinkCode>(db, sql, await sha256Hex(deviceCode));
}

export function markPolled(db: D1Database, link: LinkCode) {
  const sql = "UPDATE link_codes SET polled_at = ? WHERE device_code_hash = ?";
  return run(db, sql, Date.now(), link.device_code_hash);
}

export function denyLink(db: D1Database, link: LinkCode) {
  const sql = `UPDATE link_codes SET status = 'denied'
    WHERE device_code_hash = ? AND status = 'pending'`;
  return run(db, sql, link.device_code_hash);
}

export async function approveLink(
  db: D1Database,
  link: LinkCode,
  owner: User,
  label: string,
): Promise<"approved" | "label-taken" | "stale"> {
  const existing = await serverByLabel(db, label);
  if (existing !== null && existing.user_id !== owner.id) return "label-taken";
  const credential = newToken("bbcred");
  const hash = await sha256Hex(credential);
  const id = existing?.id ?? newId("srv");
  const claimed = await run(
    db,
    `UPDATE link_codes SET status = 'approved', server_id = ?, credential = ?
     WHERE device_code_hash = ? AND status = 'pending' AND expires_at > ?`,
    id,
    credential,
    link.device_code_hash,
    Date.now(),
  );
  if (claimed === 0) return "stale";
  await run(
    db,
    `INSERT INTO servers
       (id, user_id, label, credential_hash, client_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET credential_hash = excluded.credential_hash,
       client_name = excluded.client_name`,
    id,
    owner.id,
    label,
    hash,
    link.client_name,
    Date.now(),
  );
  return "approved";
}

export async function deliverLink(db: D1Database, link: LinkCode) {
  const delivered = await run(
    db,
    `UPDATE link_codes SET status = 'delivered', credential = NULL
     WHERE device_code_hash = ? AND status = 'approved'`,
    link.device_code_hash,
  );
  return delivered === 1;
}

export async function mintMachineCode(db: D1Database, serverId: string) {
  const counted = await one<{ machines: number }>(
    db,
    "SELECT COUNT(*) AS machines FROM machines WHERE server_id = ?",
    serverId,
  );
  if ((counted?.machines ?? 0) >= MACHINE_LIMIT) return null;
  const code = newToken("bbmc");
  const now = Date.now();
  await run(
    db,
    `INSERT INTO machines (id, server_id, code, code_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    newId("mch"),
    serverId,
    code,
    now + MACHINE_CODE_TTL_MS,
    now,
  );
  return code;
}

export async function redeemMachineCode(db: D1Database, code: string) {
  const machine = await one<Machine>(
    db,
    "SELECT id, server_id FROM machines WHERE code = ? AND code_expires_at > ?",
    code,
    Date.now(),
  );
  if (machine === null) return null;
  const credential = newToken("bbcm");
  const redeemed = await run(
    db,
    `UPDATE machines SET credential_hash = ?, code = NULL,
       code_expires_at = NULL WHERE id = ? AND code = ?`,
    await sha256Hex(credential),
    machine.id,
    code,
  );
  return redeemed === 1 ? { credential, machineId: machine.id } : null;
}

export async function machineByCredential(db: D1Database, credential: string) {
  const sql = "SELECT id, server_id FROM machines WHERE credential_hash = ?";
  return one<Machine>(db, sql, await sha256Hex(credential));
}

export function revokeMachine(db: D1Database, serverId: string, id: string) {
  const sql = "DELETE FROM machines WHERE id = ? AND server_id = ?";
  return run(db, sql, id, serverId);
}
