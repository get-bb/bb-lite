import { expect, it } from "vitest";
import * as wire from "../src/index.js";

it("recognises the plugin's local path however it is spelled", () => {
  const local = [
    wire.MCP_LOCAL_PATH,
    `${wire.MCP_LOCAL_PATH}/`,
    `${wire.MCP_LOCAL_PATH}/extra`,
    "/API/V1/Plugins/MCP/http/mcp",
    "/api/v1/plugins/%6dcp/http/mcp",
    "/api/v1/plugins/%25%36%64cp/http/mcp",
    "/api%2fv1%2Fplugins/mcp/http/mcp",
    "//api///v1/plugins/mcp/http/mcp",
    "/x/../api/v1/./plugins/mcp/http/mcp",
    "/api/v1/plugins/mcp;a=b/http/mcp;c",
    "\\api\\v1\\plugins\\mcp\\http\\mcp",
    "/api/v1/plugins/m%09cp/http/mcp%00",
  ];
  for (const path of local) expect(wire.isMcpLocalPath(path), path).toBe(true);
  const other = [
    "/mcp",
    "/api/v1/plugins/mcp/http",
    "/api/v1/plugins/mcp/http/mcpx",
    "/api/v1/plugins/mcpx/http/mcp",
    "/api/v1/plugins/connect/http/mcp",
    "/api/v1/plugins/mcp/http/mcp/../other",
  ];
  for (const path of other) expect(wire.isMcpLocalPath(path), path).toBe(false);
});

it("names the metadata paths, the challenge and the forwarded headers", () => {
  const origin = "https://bee.example.test";
  expect(wire.isMcpMetadataPath("/.well-known/oauth-protected-resource")).toBe(
    true,
  );
  expect(
    wire.isMcpMetadataPath("/.well-known/oauth-protected-resource/mcp"),
  ).toBe(true);
  expect(
    wire.isMcpMetadataPath("/.well-known/oauth-protected-resource/x"),
  ).toBe(false);
  expect(
    wire.mcpProtectedResourceMetadata(origin, "https://example.test"),
  ).toEqual({
    resource: `${origin}/mcp`,
    authorization_servers: ["https://example.test"],
    scopes_supported: ["bb"],
    bearer_methods_supported: ["header"],
    resource_name: "bb",
  });
  const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  expect(wire.mcpChallenge(origin, "invalid_token")).toBe(
    `Bearer error="invalid_token", resource_metadata="${metadata}", scope="bb"`,
  );
  const grant = { grantId: "g1", scope: "bb", clientName: "  Chät\r\n " };
  expect(wire.mcpForwardHeaders(grant)).toEqual({
    "x-bb-gate-auth": "oauth",
    "x-bb-gate-oauth-scope": "bb",
    "x-bb-gate-oauth-grant": "g1",
    "x-bb-gate-oauth-client": "Ch?t??",
  });
  expect(wire.headerSafeClientName("x".repeat(200))).toHaveLength(80);
  expect(wire.headerSafeClientName(" ‮ ")).toBe("?");
  expect(wire.headerSafeClientName("")).toBe("unknown");
});

it("reads a bearer token only from a bearer authorization header", () => {
  expect(wire.readBearerToken(undefined)).toBeNull();
  expect(wire.readBearerToken("Basic abc")).toBeNull();
  expect(wire.readBearerToken("Bearer")).toBe("");
  expect(wire.readBearerToken("  bearer   abc  ")).toBe("abc");
});
