import { fail, plugins, type PluginServerApi } from "@bb/plugin";
import { currentPrincipal } from "@bb/server-kit/http/trust";
import {
  MCP_GRANTS_PATH,
  MCP_GRANTS_REVOKE_PATH,
  MCP_PUBLIC_PATH,
} from "@bb/tunnel-contract";
import { connect, type AccountLink } from "bb-plugin-connect/contract.js";
import { join } from "node:path";
import { z } from "zod";
import { mcp, type McpGrant, type McpStatus } from "./contract.js";
import { mcpAccessProblem } from "./src/access.js";
import { createCliRunner, resolveBbBinary } from "./src/cli-runner.js";
import {
  createCommandIndexLoader,
  pluginCommandIndex,
} from "./src/command-index.js";
import { createBbMcpHttpHandler } from "./src/mcp-handler.js";

const MCP_SERVER_VERSION = "0.1.0";
const MCP_ROUTE_PATH = "/mcp";
const RELAY_TIMEOUT_MS = 15_000;
const NOT_LINKED = "This bb is not connected to a bb account.";
const LINK_HINT =
  "Run `bb connect login`, then try again. Remote MCP access goes through bb connect.";

export interface McpOptions {
  fetch: typeof globalThis.fetch;
  env: NodeJS.ProcessEnv;
}

const DEFAULTS: McpOptions = {
  fetch: (input, init) => globalThis.fetch(input, init),
  env: process.env,
};

const grantsBodySchema = z.object({
  grants: z.array(
    z.object({
      id: z.string(),
      clientId: z.string(),
      clientName: z.string(),
      scope: z.string(),
      createdAt: z.number(),
      lastUsedAt: z.number().nullable(),
    }),
  ),
});
const revokeBodySchema = z.object({ revoked: z.boolean() });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmed(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function createMcp(given: Partial<McpOptions> = {}) {
  const options = { ...DEFAULTS, ...given };
  return function mcpServer(bb: PluginServerApi): void {
    const localUrl = () =>
      `${trimmed(bb.server.url)}/api/v1/plugins/${bb.pluginId}/http${MCP_ROUTE_PATH}`;
    const bundledCli = join(bb.server.cliDir, "bin", "bb");
    const runCli = createCliRunner({
      env: options.env,
      serverUrl: () => bb.server.url,
      resolveBinary: (env) => resolveBbBinary(env, [bundledCli]),
    });
    const pluginCommands = async () => {
      try {
        const [described, contributed] = await Promise.all([
          bb.call(plugins.contracts, {}),
          bb.call(plugins.contributions, {}),
        ]);
        return pluginCommandIndex(described.contracts, contributed.cliCommands);
      } catch (error) {
        bb.log.warn(`Plugin commands not indexed: ${errorMessage(error)}`);
        return [];
      }
    };
    const handler = createBbMcpHttpHandler(
      {
        runCli,
        loadCommandIndex: createCommandIndexLoader({ runCli, pluginCommands }),
      },
      MCP_SERVER_VERSION,
      (error) => bb.log.warn(`MCP request failed: ${error.message}`),
    );
    bb.onDispose(() => handler.close());

    const serve = async (request: Request): Promise<Response> => {
      const principal = currentPrincipal();
      const problem = mcpAccessProblem(request.headers, {
        ownMachine: principal.kind === "user" && principal.implicit,
        tunnelToken: bb.server.tunnelToken,
      });
      if (problem === null) return handler.fetch(request);
      const body = { error: "forbidden", message: problem.message };
      return Response.json(body, { status: problem.status });
    };
    for (const method of ["POST", "GET", "DELETE"]) {
      bb.http.route(method, MCP_ROUTE_PATH, serve, { auth: "none" });
    }

    const link = (): AccountLink => {
      const found = bb.pick(connect.link)?.() ?? null;
      if (found !== null) return found;
      return fail("unavailable", NOT_LINKED, {
        reason: "not_signed_in",
        hint: LINK_HINT,
      });
    };

    const relay = async <T>(
      path: string,
      body: Record<string, string> | null,
      schema: z.ZodType<T>,
      signal: AbortSignal,
    ): Promise<T> => {
      const { serverUrl, credential } = link();
      const timeout = AbortSignal.timeout(RELAY_TIMEOUT_MS);
      const response = await options.fetch(`${trimmed(serverUrl)}${path}`, {
        method: body === null ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
      });
      if (response.status === 401) {
        return fail("unavailable", "The bb account refused this bb's link.", {
          reason: "not_signed_in",
          hint: LINK_HINT,
        });
      }
      if (response.status !== 200) {
        const message = `The bb account service answered ${response.status}.`;
        return fail("unavailable", message, {
          reason: "account_request_failed",
        });
      }
      const parsed = schema.safeParse(await response.json().catch(() => null));
      if (parsed.success) return parsed.data;
      const message = "The bb account service sent an unexpected answer.";
      return fail("unavailable", message, { reason: "account_request_failed" });
    };

    const remote = async (): Promise<Pick<McpStatus, "remoteUrl">> => {
      const { url } = await bb.call(connect.status, {});
      const remoteUrl =
        url === null ? null : `${trimmed(url)}${MCP_PUBLIC_PATH}`;
      return { remoteUrl };
    };

    bb.implement(mcp.status, async (): Promise<McpStatus> => {
      try {
        const { remoteUrl } = await remote();
        const remoteProblem =
          remoteUrl === null
            ? "sign in with `bb connect login` and turn on bb connect"
            : null;
        return { remoteUrl, localUrl: localUrl(), remoteProblem };
      } catch (error) {
        const remoteProblem = errorMessage(error);
        return { remoteUrl: null, localUrl: localUrl(), remoteProblem };
      }
    });

    bb.implement(
      mcp.clients,
      async (_input, { signal }): Promise<McpGrant[]> => {
        const body = await relay(
          MCP_GRANTS_PATH,
          null,
          grantsBodySchema,
          signal,
        );
        return body.grants;
      },
    );

    bb.implement(mcp.revoke, async ({ grantId }, { signal }) => {
      const sent = { grantId };
      const body = await relay(
        MCP_GRANTS_REVOKE_PATH,
        sent,
        revokeBodySchema,
        signal,
      );
      if (body.revoked) return { revoked: true as const, grantId };
      return fail("not_found", `No connected app has id ${grantId}.`, {
        reason: "unknown_grant",
        hint: "Run `bb mcp clients` for the ids.",
      });
    });
  };
}

export default createMcp();
