export const VIA_TUNNEL_HEADER = "x-bb-via-tunnel";
export const GATE_AUTH_HEADER = "x-bb-gate-auth";
export const GATE_OAUTH_AUTH_KIND = "oauth";
export const GATE_OAUTH_SCOPE_HEADER = "x-bb-gate-oauth-scope";
export const GATE_OAUTH_GRANT_HEADER = "x-bb-gate-oauth-grant";
export const GATE_OAUTH_CLIENT_HEADER = "x-bb-gate-oauth-client";
export const MCP_SCOPE = "bb";

export interface McpAccessProblem {
  status: 403;
  message: string;
}

export interface McpRequestTrust {
  ownMachine: boolean;
  tunnelToken: string;
}

function refuse(message: string): McpAccessProblem {
  return { status: 403, message };
}

function localProblem(
  headers: Headers,
  ownMachine: boolean,
): McpAccessProblem | null {
  if (headers.get(GATE_AUTH_HEADER) !== null) {
    return refuse(
      "Reach the bb MCP endpoint at /mcp on this bb's public address with an OAuth access token.",
    );
  }
  if (!ownMachine) {
    return refuse(
      "The local bb MCP address accepts only apps on the bb server's own machine. Other apps use /mcp on this bb's public address.",
    );
  }
  return headers.get("origin") === null
    ? null
    : refuse("The bb MCP endpoint does not accept requests from web pages.");
}

function gateProblem(headers: Headers): McpAccessProblem | null {
  if (headers.get(GATE_AUTH_HEADER) !== GATE_OAUTH_AUTH_KIND) {
    return refuse(
      "Reach the bb MCP endpoint at /mcp with an OAuth access token.",
    );
  }
  const scopes = (headers.get(GATE_OAUTH_SCOPE_HEADER) ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  return scopes.includes(MCP_SCOPE)
    ? null
    : refuse("This access token carries no bb scope.");
}

export function mcpAccessProblem(
  headers: Headers,
  trust: McpRequestTrust,
): McpAccessProblem | null {
  const marker = headers.get(VIA_TUNNEL_HEADER);
  if (marker === null) return localProblem(headers, trust.ownMachine);
  if (marker !== trust.tunnelToken) {
    return refuse("This request did not come through bb connect.");
  }
  return gateProblem(headers);
}
