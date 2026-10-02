import { z } from "zod";
import type { Account, ModelFamily } from "./contract.js";
import { modelFamily } from "./limits.js";

export type Bytes = Uint8Array<ArrayBuffer>;

export interface ParsedRequest {
  family: ModelFamily;
  affinityId: string | null;
  parentAffinityId: string | null;
  forAccount(account: Account): Bytes;
}

const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const ACCOUNT_COMPONENT = new RegExp(`(^|_)account_(${UUID})(?=_|$)`, "iu");
const SESSION_COMPONENT = new RegExp(`(?:^|_)session_(${UUID})$`, "iu");
const CONTROL_CHARACTERS = /\p{Cc}/u;

const recordSchema = z.record(z.string(), z.unknown());
const claudeRequestSchema = z.looseObject({
  model: z.string().nullish(),
  metadata: z.looseObject({ user_id: z.string().nullish() }).nullish(),
});

function jsonRecord(text: string | null): Record<string, unknown> | null {
  try {
    return recordSchema.safeParse(JSON.parse(text ?? "")).data ?? null;
  } catch {
    return null;
  }
}

function identifier(value: unknown): string | null {
  const usable =
    typeof value === "string" &&
    value.length <= 512 &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTERS.test(value);
  return usable ? value : null;
}

function session(id: string | null): string | null {
  return id === null ? null : `session:${id}`;
}

function parseUserId(userId: string) {
  const encoded = jsonRecord(userId);
  if (encoded !== null) {
    const stored = z.uuid().nullish().safeParse(encoded.account_uuid).data;
    const sessionId = identifier(encoded.session_id);
    const parent = identifier(encoded.parent_session_id);
    return {
      sessionId,
      parentSessionId:
        sessionId === null || parent === sessionId ? null : parent,
      forAccount(accountUuid: string): string | null {
        if (stored === undefined || stored === accountUuid) return null;
        return JSON.stringify({ ...encoded, account_uuid: accountUuid });
      },
    };
  }
  return {
    sessionId: identifier(SESSION_COMPONENT.exec(userId)?.[1]),
    parentSessionId: null,
    forAccount(accountUuid: string): string | null {
      const rewritten = userId.replace(
        ACCOUNT_COMPONENT,
        (_match, prefix: string) => `${prefix}account_${accountUuid}`,
      );
      return rewritten === userId ? null : rewritten;
    },
  };
}

export function parseClaudeRequest(body: Bytes): ParsedRequest {
  const unparsed = { family: "other" as const, affinityId: null };
  const untouched = { parentAffinityId: null, forAccount: () => body };
  const parsed = claudeRequestSchema.safeParse(
    jsonRecord(new TextDecoder().decode(body)),
  );
  if (!parsed.success) return { ...unparsed, ...untouched };
  const request = parsed.data;
  const userId = request.metadata?.user_id;
  const user = userId == null ? null : parseUserId(userId);
  return {
    family: modelFamily(request.model ?? null),
    affinityId: session(user?.sessionId ?? null),
    parentAffinityId: session(user?.parentSessionId ?? null),
    forAccount({ accountUuid }) {
      if (accountUuid === null || user === null) return body;
      const rewritten = user.forAccount(accountUuid);
      if (rewritten === null) return body;
      const metadata = { ...request.metadata, user_id: rewritten };
      return new TextEncoder().encode(JSON.stringify({ ...request, metadata }));
    },
  };
}

export function parseCodexRequest(
  body: Bytes,
  headers: Headers,
): ParsedRequest {
  const request = jsonRecord(new TextDecoder().decode(body));
  const client = recordSchema.safeParse(request?.client_metadata).data;
  const embedded = client?.["x-codex-turn-metadata"];
  const headerTurn = jsonRecord(headers.get("x-codex-turn-metadata"));
  const bodyTurn = jsonRecord(typeof embedded === "string" ? embedded : null);
  const first = (values: unknown[], except?: string | null) =>
    values.map(identifier).find((id) => id !== null && id !== except) ?? null;
  const sessionId = first([
    headers.get("thread-id"),
    headerTurn?.thread_id,
    client?.thread_id,
    bodyTurn?.thread_id,
    headers.get("session-id"),
    headers.get("session_id"),
    headerTurn?.session_id,
    client?.session_id,
    bodyTurn?.session_id,
  ]);
  const parents = [
    headerTurn?.forked_from_thread_id,
    bodyTurn?.forked_from_thread_id,
    headers.get("x-codex-parent-thread-id"),
    headerTurn?.parent_thread_id,
    client?.["x-codex-parent-thread-id"],
    bodyTurn?.parent_thread_id,
  ];
  const cacheKey = identifier(request?.prompt_cache_key);
  return {
    family: "other",
    affinityId:
      session(sessionId) ?? (cacheKey === null ? null : `cache:${cacheKey}`),
    parentAffinityId:
      sessionId === null ? null : session(first(parents, sessionId)),
    forAccount: () => body,
  };
}

export function upstreamHeaders(
  inbound: Headers,
  allowed: readonly string[],
  prefixes: readonly string[],
): Headers {
  const headers = new Headers();
  for (const [name, value] of inbound) {
    const prefixed = prefixes.some((prefix) => name.startsWith(prefix));
    if (allowed.includes(name) || prefixed) headers.append(name, value);
  }
  return headers;
}

export function upstreamUrl(
  request: Request,
  baseUrl: string,
  stripPrefix = "",
): URL {
  const { pathname, search } = new URL(request.url);
  const mounted = pathname.indexOf("/http/");
  const path = (mounted < 0 ? pathname : pathname.slice(mounted + 5)).replace(
    /^\//u,
    "",
  );
  const relative = path.startsWith(stripPrefix)
    ? path.slice(stripPrefix.length)
    : path;
  return new URL(
    relative + search,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
}
