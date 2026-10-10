import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import type { PermissionMode } from "@bb/domain";
import { expect, it, vi } from "vitest";
import { createHarness } from "./adapter-harness.js";
import {
  accepted,
  answerWith,
  agentTexts,
  closeSessionsAfterEach,
  fakeLaunch,
  lastCompleted,
  loggedPrompts,
  openSession,
  permissionCli,
  runTurn,
  started,
  startTurn,
  steer,
} from "./sessions-helpers.js";

closeSessionsAfterEach();

it("lists skills/configure roots in canonical session instructions", async () => {
  const promptLog = join(tmpdir(), `bb-acp-skills-${process.pid}.jsonl`);
  rmSync(promptLog, { force: true });
  const harness = createHarness({
    env: { FAKE_ACP_PROMPT_LOG: promptLog },
    instructions: "Be terse.",
  });
  const root = join(harness.dir, "skills");
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(
    join(root, "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Ship the app.\n---\nSteps.\n",
  );
  const session = await openSession(harness, { skillDirs: [root] });
  await harness.turn(session, "hi");
  const [prompt] = loggedPrompts(promptLog);
  expect(prompt).toContain("Available bb skills:");
  expect(prompt).toContain(
    `- deploy: Ship the app. (SKILL.md: ${join(root, "deploy", "SKILL.md")})`,
  );
  rmSync(promptLog, { force: true });
});

it("prepends instructions to the first prompt only", async () => {
  const { harness, session } = await started({ instructions: "Be terse." });
  await harness.turn(session, "hi");
  await harness.turn(session, "again");
  expect(agentTexts(harness)).toEqual([
    "echo:<system_instructions>\nBe terse.\n</system_instructions>\nhi",
    "echo:again",
  ]);
});

it("auto-allows permission requests in full mode", async () => {
  const { harness, session } = await started({ permissionMode: "full" });
  await harness.turn(session, "request-permission");
  expect(harness.interactions).toEqual([]);
  expect(agentTexts(harness)).toContain("permission:yes");
});

it("forwards permission requests to the runtime in ask mode", async () => {
  const { harness, session } = await started({
    permissionMode: "accept-edits",
  });
  answerWith(harness, "deny");
  await harness.turn(session, "request-permission");
  expect(harness.interactions).toEqual([
    expect.objectContaining({
      kind: "approval",
      subject: expect.objectContaining({ command: "rm -rf /tmp/scratch" }),
    }),
  ]);
  expect(agentTexts(harness)).toContain("permission:no");
});

it("presents an external-directory write permission as a file-change approval", async () => {
  const { harness, session } = await started({
    permissionMode: "accept-edits",
  });
  answerWith(harness, "allow_once");
  await harness.turn(session, "request-external-directory-permission");
  expect(harness.interactions).toEqual([
    expect.objectContaining({
      kind: "approval",
      subject: expect.objectContaining({
        kind: "file_change",
        itemId: "write-tool-1",
        writeScope: normalize("/tmp/qa-1719"),
      }),
    }),
  ]);
  expect(agentTexts(harness)).toContain("permission:yes");
});

it("answers session-grant decisions with the allow_always option", async () => {
  const { harness, session } = await started({
    permissionMode: "accept-edits",
  });
  answerWith(harness, "allow_for_session");
  await harness.turn(session, "request-permission");
  expect(agentTexts(harness)).toContain("permission:always");
});

it.each(["add", "update"])("acknowledges fs %s writes", async (kind) => {
  const harness = createHarness({ permissionMode: "accept-edits" });
  const targetPath = join(harness.dir, "agent-output.txt");
  if (kind === "update") writeFileSync(targetPath, "original content\n");
  harness.agent.launch.env = { FAKE_ACP_WRITE_PATH: targetPath };
  const session = await openSession(harness);
  await harness.turn(session, "write-file");
  expect(agentTexts(harness)).toContain("write:ok");
  expect(readFileSync(targetPath, "utf8")).toBe("hello from agent\n");
  expect(harness.items()).toContainEqual(
    expect.objectContaining({
      type: "fileChange",
      changes: [expect.objectContaining({ path: targetPath, kind })],
    }),
  );
});

const modes: PermissionMode[] = ["accept-edits", "full"];
const reconcileCases = modes.flatMap((before) =>
  modes.flatMap((after) =>
    ["start", "steer"].flatMap((method) =>
      [false, true].flatMap((cli) =>
        [false, true].map((load) => ({ before, after, method, cli, load })),
      ),
    ),
  ),
);

it.each(reconcileCases)(
  "reconciles $before -> $after on $method (CLI: $cli, load: $load)",
  async ({ before, after, method, cli, load }) => {
    const outsideDir = mkdtempSync(join(tmpdir(), "bb-acp-permission-probe-"));
    const targetPath = join(outsideDir, "probe.txt");
    const env = {
      FAKE_ACP_WRITE_PATH: targetPath,
      FAKE_ACP_LOAD_SESSION: load ? "1" : "0",
    };
    const extra = cli ? { permissionCli } : {};
    try {
      const { harness, session } = await started({
        permissionMode: before,
        agent: fakeLaunch(env, extra),
      });
      const probes = () =>
        agentTexts(harness).flatMap((value) =>
          value.startsWith('{"wrote":')
            ? [JSON.parse(value) as { wrote: boolean; args: string[] }]
            : [],
        );
      if (method === "steer") {
        await startTurn(harness, session, "hang");
        await vi.waitFor(() => expect(harness.host.events.activeTurnId));
        const mode = { permissionMode: after };
        expect(await steer(harness, session, "permission-probe", mode)).toBe(
          "steered",
        );
        await vi.waitFor(() => {
          harness.host.events.flush();
          expect(probes()).toHaveLength(1);
        });
      } else {
        await runTurn(harness, session, "permission-probe", {
          permissionMode: after,
        });
      }
      const [probe] = probes();
      const wrote = after === "full";
      expect(probe?.wrote).toBe(wrote);
      expect(existsSync(targetPath)).toBe(wrote);
      if (cli) {
        expect(probe?.args).toContain(wrote ? "--full" : "--workspace");
        expect(probe?.args).not.toContain(wrote ? "--workspace" : "--full");
      }
      const replaced = harness.events.filter(
        (event) => event.type === "thread/identity",
      );
      const contextLost = cli && before !== after && !load;
      expect(replaced).toHaveLength(contextLost ? 2 : 1);
      const lost = harness.events.some(
        (event) => event.type === "provider/warning",
      );
      expect(lost).toBe(contextLost);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  },
);

it("rejects simultaneous starts while reconciling unchanged permissions", async () => {
  const { harness, session } = await started();
  const first = startTurn(harness, session, "hang");
  const second = startTurn(harness, session, "second");
  await expect(first).resolves.toBeDefined();
  await expect(second).rejects.toMatchObject({
    code: "competing_turn",
    message: "A turn is already active",
  });
  harness.host.events.flush();
  expect(accepted(harness)).toHaveLength(1);
});

it("preserves stacked steers across permission CLI rebuilds", async () => {
  const probe = createHarness();
  const promptLog = join(probe.dir, "permission-prompts.jsonl");
  const env = { FAKE_ACP_LOAD_SESSION: "1", FAKE_ACP_PROMPT_LOG: promptLog };
  const { harness, session } = await started({
    agent: fakeLaunch(env, { permissionCli }),
  });
  const firstId = await startTurn(harness, session, "hang");
  await vi.waitFor(() => expect(harness.host.events.activeTurnId));
  const first = steer(
    harness,
    session,
    "echo-argv first",
    { permissionMode: "accept-edits" },
    "creq_steer_first",
  );
  const second = steer(
    harness,
    session,
    "echo-argv second",
    { permissionMode: "full" },
    "creq_steer_second",
  );
  expect(await first).toBe("steered");
  expect(await second).toBe("steered");
  await vi.waitFor(() => {
    harness.host.events.flush();
    const identities = harness.events.filter(
      (event) => event.type === "thread/identity",
    );
    expect(identities).toHaveLength(1);
    expect(agentTexts(harness).join("\n")).toContain("argv:--full");
  });
  expect(loggedPrompts(promptLog)).toEqual([
    "hang",
    "echo-argv first",
    "echo-argv second",
  ]);
  expect(accepted(harness)).toEqual([
    firstId,
    "creq_steer_first",
    "creq_steer_second",
  ]);
});

it("denies client fs writes outside the workspace in accept-edits mode", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "bb-acp-outside-"));
  const targetPath = join(outsideDir, "outside.txt");
  try {
    const { harness, session } = await started({
      permissionMode: "accept-edits",
      env: { FAKE_ACP_WRITE_PATH: targetPath },
    });
    await harness.turn(session, "write-file");
    expect(agentTexts(harness)).toContain("write:denied");
    expect(existsSync(targetPath)).toBe(false);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

it("allows canonical accept-edits writes into a configured extra write root", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "bb-acp-extra-root-"));
  const targetPath = join(outsideDir, "outside.txt");
  try {
    const harness = createHarness({
      permissionMode: "accept-edits",
      env: { FAKE_ACP_WRITE_PATH: targetPath },
    });
    harness.host.writableRoots = [outsideDir];
    const session = await openSession(harness);
    await harness.turn(session, "write-file");
    expect(lastCompleted(harness)).toMatchObject({ status: "completed" });
    expect(agentTexts(harness)).toContain("write:ok");
    expect(readFileSync(targetPath, "utf8")).toBe("hello from agent\n");
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

it("reports a permission-changing steer whose replacement fails to start", async () => {
  const { harness, session } = await started({
    agent: fakeLaunch({}, { permissionCli }),
  });
  const firstId = await startTurn(harness, session, "hang");
  await vi.waitFor(() => expect(harness.host.events.activeTurnId));
  harness.agent.launch.env = {
    FAKE_ACP_SESSION_NEW_ERROR: "permission restart failed",
  };
  const mode = { permissionMode: "accept-edits" as const };
  expect(await steer(harness, session, "echo-argv", mode)).toBe("steered");
  await vi.waitFor(() =>
    expect(harness.exits).toContainEqual(
      expect.objectContaining({ message: "permission restart failed" }),
    ),
  );
  expect(agentTexts(harness)).toEqual([]);
  expect(accepted(harness)).toEqual([firstId]);
});
