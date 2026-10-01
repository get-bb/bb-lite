import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.js";
import { findHost, updateHost, type HostRow } from "../db/hosts.js";
import { ApiError } from "../http/errors.js";
import type { Principal } from "../http/trust.js";

export interface JoinToken {
  joinToken: string;
  expiresAt: number;
}

export interface JoinBlob {
  serverUrl: string;
  hostId: string;
  joinToken: string;
}

export interface RunnerCredential {
  hostId: string;
  runnerToken: string;
}

const JOIN_TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_BYTES = 32;
const BEARER = /^Bearer (\S+)$/u;

function mintToken(prefix: "bbj" | "bbr"): string {
  return `${prefix}_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(stored: string | null, presented: string): boolean {
  if (stored === null || stored.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(presented));
}

function rejectCredential(code: string, message: string): ApiError {
  return new ApiError(401, code, message);
}

function bearerToken(authorization: string | undefined): string | null {
  return BEARER.exec(authorization ?? "")?.[1] ?? null;
}

export function issueJoinToken(db: Db, hostId: string): JoinToken {
  const joinToken = mintToken("bbj");
  const expiresAt = db.now() + JOIN_TOKEN_TTL_MS;
  const joinTokenHash = hashToken(joinToken);
  updateHost(db, hostId, { joinTokenHash, joinExpiresAt: expiresAt });
  return { joinToken, expiresAt };
}

export function joinCommand(blob: JoinBlob): string {
  const encoded = Buffer.from(JSON.stringify(blob)).toString("base64url");
  return `bb runner join ${encoded}`;
}

export function redeemJoinToken(
  db: Db,
  request: {
    authorization: string | undefined;
    principal: Principal;
    hostName: string | undefined;
  },
): RunnerCredential {
  const refusal = rejectCredential(
    "invalid_join_token",
    "This join token is unknown, already used or expired. Create a new " +
      "command from the machines settings.",
  );
  const token = bearerToken(request.authorization);
  if (token === null) throw refusal;
  const presented = hashToken(token);
  return db.transaction(() => {
    const host = findHost(db, "join_token_hash", presented);
    if (host === undefined || !sameHash(host.joinTokenHash, presented)) {
      throw refusal;
    }
    if ((host.joinExpiresAt ?? 0) <= db.now()) throw refusal;
    const runnerToken = mintToken("bbr");
    const { principal, hostName } = request;
    updateHost(db, host.id, {
      joinTokenHash: null,
      joinExpiresAt: null,
      tokenHash: hashToken(runnerToken),
      name: host.phase === "creating" ? hostName : undefined,
      connectMachineId:
        principal.kind === "runner" ? principal.connectMachineId : undefined,
    });
    return { hostId: host.id, runnerToken };
  });
}

export function authenticateRunner(
  db: Db,
  request: { authorization: string | undefined; principal: Principal },
): HostRow {
  const token = bearerToken(request.authorization);
  const presented = token === null ? null : hashToken(token);
  const host =
    presented === null ? undefined : findHost(db, "token_hash", presented);
  if (
    presented === null ||
    host === undefined ||
    !sameHash(host.tokenHash, presented)
  ) {
    throw rejectCredential(
      "invalid_runner_token",
      "This runner token is not valid for any machine on this server.",
    );
  }
  const { principal } = request;
  if (
    principal.kind === "runner" &&
    principal.connectMachineId !== host.connectMachineId
  ) {
    throw new ApiError(
      403,
      "forbidden",
      "This runner token belongs to a different bb connect machine.",
    );
  }
  return host;
}
