export const MCP_PUBLIC_PATH = "/mcp";
export const MCP_LOCAL_PATH = "/api/v1/plugins/mcp/http/mcp";
export const MCP_SCOPE = "bb";
export const MCP_GRANT_CACHE_TTL_MS = 30_000;

export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";
export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_REVOKE_PATH = "/oauth/revoke";

export const MCP_GRANTS_PATH = "/api/connect/mcp/grants";
export const MCP_GRANTS_REVOKE_PATH = "/api/connect/mcp/grants/revoke";

export const GATE_AUTH_HEADER = "x-bb-gate-auth";
export const GATE_OAUTH_AUTH_KIND = "oauth";
export const GATE_OAUTH_SCOPE_HEADER = "x-bb-gate-oauth-scope";
export const GATE_OAUTH_GRANT_HEADER = "x-bb-gate-oauth-grant";
export const GATE_OAUTH_CLIENT_HEADER = "x-bb-gate-oauth-client";

export interface McpGrant {
  grantId: string;
  scope: string;
  clientName: string;
  expiresAt: number;
}

export interface McpGrantView {
  id: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const CLIENT_NAME_HEADER_MAX_LENGTH = 80;
const PATH_DECODE_ROUNDS = 4;
const METADATA_PATHS = [
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  `${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}${MCP_PUBLIC_PATH}`,
];

function decodeOnce(value: string): string {
  return value.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

export function isMcpLocalPath(pathname: string): boolean {
  let decoded = pathname;
  for (let round = 0; round < PATH_DECODE_ROUNDS; round += 1) {
    const next = decodeOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  const segments: string[] = [];
  for (const raw of decoded.toLowerCase().split(/[/\\]+/u)) {
    const segment = raw.replace(/;.*$/u, "").replace(/[\s\0]+/gu, "");
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `/${segments.join("/")}`;
  return (
    normalized === MCP_LOCAL_PATH || normalized.startsWith(`${MCP_LOCAL_PATH}/`)
  );
}

export function isMcpMetadataPath(pathname: string): boolean {
  return METADATA_PATHS.includes(pathname);
}

export function mcpResourceForOrigin(origin: string): string {
  return `${origin}${MCP_PUBLIC_PATH}`;
}

export function mcpProtectedResourceMetadata(
  origin: string,
  authorizationServer: string,
) {
  return {
    resource: mcpResourceForOrigin(origin),
    authorization_servers: [authorizationServer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "bb",
  };
}

export function mcpChallenge(
  origin: string,
  error: "invalid_token" | null,
): string {
  const metadata = `${origin}${METADATA_PATHS[1]}`;
  const parameters = [
    ...(error === null ? [] : [`error="${error}"`]),
    `resource_metadata="${metadata}"`,
    `scope="${MCP_SCOPE}"`,
  ];
  return `Bearer ${parameters.join(", ")}`;
}

export function headerSafeClientName(value: string): string {
  const safe = value
    .replace(/[^\x20-\x7e]/gu, "?")
    .trim()
    .slice(0, CLIENT_NAME_HEADER_MAX_LENGTH)
    .trim();
  return safe === "" ? "unknown" : safe;
}

export function readBearerToken(
  authorization: string | null | undefined,
): string | null {
  const match = /^bearer(?:\s+(.*))?$/iu.exec((authorization ?? "").trim());
  return match === null ? null : (match[1] ?? "").trim();
}

export function mcpForwardHeaders(grant: McpGrant): Record<string, string> {
  return {
    [GATE_AUTH_HEADER]: GATE_OAUTH_AUTH_KIND,
    [GATE_OAUTH_SCOPE_HEADER]: grant.scope,
    [GATE_OAUTH_GRANT_HEADER]: grant.grantId,
    [GATE_OAUTH_CLIENT_HEADER]: headerSafeClientName(grant.clientName),
  };
}
