import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ACP_BRIDGE_MCP_SERVER_NAME } from "../runner/bridge/tool-proxy-mcp.js";
import { createHarness, FAKE_AGENT } from "./adapter-harness.js";
import {
  agentTexts,
  closeSessionsAfterEach,
  lastCompleted,
  openFailure,
  openSession,
  started,
} from "./sessions-helpers.js";

closeSessionsAfterEach();

it("starts a session and runs a prompt turn end to end", async () => {
  const { harness, session } = await started();
  expect(session.providerThreadId).toMatch(/^fake-sess-\d+$/u);
  expect(harness.events[0]).toMatchObject({
    type: "thread/identity",
    providerThreadId: session.providerThreadId,
  });
  await harness.turn(session, "hello there");
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  const turns = harness.types().filter((type) => type === "turn/started");
  expect(turns).toHaveLength(1);
  expect(agentTexts(harness)).toContain("echo:hello there");
});

it("rebuilds the agent with environment from a later turn", async () => {
  const harness = createHarness({ env: { FAKE_ACP_LOAD_SESSION: "1" } });
  harness.host.env = { FAKE_ACP_PROMPT_ERROR: "1" };
  const first = await openSession(harness);
  await first.close();
  harness.host.env = { FAKE_ACP_PROMPT_ERROR: "0" };
  const providerThreadId = first.providerThreadId;
  const session = await openSession(harness, { providerThreadId });
  await harness.turn(session, "fresh environment");
  expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
  expect(agentTexts(harness)).toContain("echo:fresh environment");
});

it("authenticates ACP sessions with cached tokens when advertised", async () => {
  const env = { FAKE_ACP_AUTH_METHODS: "cached_token" };
  const { harness, session } = await started({ env });
  await harness.turn(session, "echo-auth-method");
  expect(agentTexts(harness)).toContain("auth-method:cached_token");
});

it("prefers xAI API-key auth when XAI_API_KEY is available", async () => {
  const env = {
    FAKE_ACP_AUTH_METHODS: "cached_token,xai.api_key",
    XAI_API_KEY: "xai-test-key",
  };
  const { harness, session } = await started({ env });
  await harness.turn(session, "echo-auth-method");
  expect(agentTexts(harness)).toContain("auth-method:xai.api_key");
});

it("lets agents surface their own error for unsupported advertised auth methods", async () => {
  const env = { FAKE_ACP_AUTH_METHODS: "agent.login" };
  const error = await openFailure({ env });
  expect(error.message).toContain("Authentication required");
  expect(error.message).not.toContain("does not support");
  expect(error.code).toBe("auth_required");
});

it("tells the user how to sign in, from the methods the agent advertised", async () => {
  const named = await openFailure({
    env: { FAKE_ACP_AUTH_METHODS: "agent.login" },
  });
  expect(named.message).toMatch(
    /^Authentication required[^.]*\. The agent offers these ways to sign in: Sign in \(agent\.login\)\. Sign in with the agent's own command/u,
  );
  const terminal = await openFailure({
    env: {
      FAKE_ACP_AUTH_METHODS: "agent.login",
      FAKE_ACP_TERMINAL_AUTH_ARGS: "login --device",
    },
  });
  expect(terminal.message).toMatch(
    /To sign in, run this in a terminal on the machine that hosts the thread, then try again: \S*node(?:\.exe)? \S*fake-acp-agent\.mjs login --device$/u,
  );
  expect(terminal.code).toBe("auth_required");
});

it("keeps a non-auth session failure untyped when the agent advertises a login bb cannot perform", async () => {
  const error = await openFailure({
    env: {
      FAKE_ACP_AUTH_METHODS: "agent.login",
      FAKE_ACP_AUTH_OPTIONAL: "1",
      FAKE_ACP_SESSION_NEW_ERROR:
        "workspace /nope/does/not/exist is not a directory",
    },
  });
  expect(error.message).toContain(
    "workspace /nope/does/not/exist is not a directory",
  );
  expect(error.code).toBe("failed");
});

it("keeps an agent exit during session/new untyped when the agent advertises a login bb cannot perform", async () => {
  const error = await openFailure({
    env: {
      FAKE_ACP_AUTH_METHODS: "agent.login",
      FAKE_ACP_AUTH_OPTIONAL: "1",
      FAKE_ACP_EXIT_ON_SESSION_NEW: "7",
    },
  });
  expect(error.message).toMatch(/exited \(code 7/u);
  expect(error.code).toBe("failed");
});

it("approves Cursor session MCP servers for the session lifetime (#2018)", async () => {
  const probe = createHarness();
  const cursorAgent = join(probe.dir, "cursor-agent");
  const cursorDataDir = join(probe.dir, "cursor-data");
  symlinkSync(process.execPath, cursorAgent);
  const harness = createHarness({
    agent: {
      launch: {
        displayName: "Cursor",
        command: cursorAgent,
        args: [FAKE_AGENT],
        env: { CURSOR_DATA_DIR: cursorDataDir },
      },
    },
    dynamicTools: [
      {
        name: "update_environment_directory",
        description: "Move this thread to another environment directory.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  const session = await openSession(harness);
  const projectSlug = harness.dir
    .replace(/[^a-zA-Z0-9]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const approvalPath = join(
    cursorDataDir,
    "projects",
    projectSlug,
    "mcp-approvals.json",
  );
  const approvals = JSON.parse(readFileSync(approvalPath, "utf8")) as unknown;
  expect(approvals).toEqual([
    expect.stringMatching(`^${ACP_BRIDGE_MCP_SERVER_NAME}-[a-f0-9]{16}$`),
  ]);
  await session.close();
  expect(JSON.parse(readFileSync(approvalPath, "utf8")) as unknown).toEqual([]);
});
