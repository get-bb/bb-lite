import { join } from "node:path";
import type { PromptInput } from "@bb/domain";
import type { ProviderSession } from "@bb/runner";
import { describe, expect, it } from "vitest";
import type { AcpExecutionOptions } from "../runner/engine.js";
import { createHarness } from "./adapter-harness.js";
import {
  type Harness,
  jsonLines,
  ofType,
  trackSessions,
} from "./lifecycle-helpers.js";

const tracked = trackSessions();

interface LoggedRequest {
  method?: string;
  params?: unknown;
}

function states(harness: Harness, kind: string): unknown[] {
  return ofType(harness, "thread/extensionState/updated")
    .filter((event) => event.kind === kind)
    .map((event) => event.payload);
}

function setConfigRequests(log: string): unknown[] {
  return jsonLines<LoggedRequest>(log)
    .filter((request) => request.method === "session/set_config_option")
    .map((request) => request.params);
}

type Selections = NonNullable<AcpExecutionOptions["sessionOptions"]>;

function requesting(session: ProviderSession, sessionOptions: Selections) {
  const startTurn = session.startTurn.bind(session);
  session.startTurn = (turn) =>
    startTurn({ ...turn, options: { ...turn.options, sessionOptions } });
  const steer = session.steer.bind(session);
  session.steer = (input) =>
    steer({ ...input, options: { ...input.options, sessionOptions } });
}

const OPTIONS = [
  {
    id: "approach",
    label: "Approach",
    description: "How the agent works on a task",
    category: "mode",
    type: "select",
    value: "build",
    values: [
      { id: "build", label: "Build" },
      { id: "plan", label: "Plan", description: "Read only" },
    ],
  },
  { id: "web", label: "Web search", type: "boolean", value: false },
];

describe("acp adapter: live session state", () => {
  it("publishes the agent's slash commands once per distinct list", async () => {
    const { harness, session } = await tracked.start();
    await harness.turn(session, "advertise-commands");
    expect(states(harness, "bb/provider-commands")).toEqual([
      {
        commands: [
          { name: "review", description: "Review the current diff" },
          { name: "web", description: "Search the web", inputHint: "query" },
        ],
      },
    ]);
  });

  it("publishes the session's own options and leaves the model and reasoning to bb's pickers", async () => {
    const { harness } = await tracked.start({
      env: { FAKE_ACP_SESSION_OPTIONS: "1" },
    });
    expect(states(harness, "bb/session-options")).toEqual([
      { options: OPTIONS },
    ]);
  });

  it("publishes no session options for an agent whose only options are its model and thought level", async () => {
    const harness = createHarness({
      env: { FAKE_ACP_MODEL_CONFIG: "1", FAKE_ACP_THOUGHT_LEVEL_CONFIG: "1" },
    });
    harness.execution.model = "fake/strong";
    harness.execution.reasoningLevel = "high";
    await tracked.open(harness);
    expect(states(harness, "bb/session-options")).toEqual([]);
  });

  it("applies requested session options before the prompt and does not repeat a value the session already has", async () => {
    const log = join(createHarness().dir, "requests.log");
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_SESSION_OPTIONS: "1", FAKE_ACP_REQUEST_LOG: log },
    });
    requesting(session, { approach: "plan", web: true, absent: "anything" });
    await harness.turn(session, "hello");
    const sessionId = session.providerThreadId;
    expect(setConfigRequests(log)).toEqual([
      { sessionId, configId: "approach", value: "plan" },
      { sessionId, configId: "web", type: "boolean", value: true },
    ]);
    const methods = jsonLines<LoggedRequest>(log).map(
      (request) => request.method,
    );
    expect(methods.lastIndexOf("session/set_config_option")).toBeLessThan(
      methods.indexOf("session/prompt"),
    );
    expect(states(harness, "bb/session-options").at(-1)).toMatchObject({
      options: [
        { id: "approach", value: "plan" },
        { id: "web", value: true },
      ],
    });
    await harness.turn(session, "again");
    expect(setConfigRequests(log)).toHaveLength(2);
  });

  it("never sends a value the option does not offer", async () => {
    const log = join(createHarness().dir, "requests.log");
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_SESSION_OPTIONS: "1", FAKE_ACP_REQUEST_LOG: log },
    });
    requesting(session, { approach: "yolo", web: "true" });
    await harness.turn(session, "hello");
    expect(setConfigRequests(log)).toEqual([]);
  });

  it("warns and keeps the agent's value when the agent rejects a requested option", async () => {
    const { harness, session } = await tracked.start({
      env: {
        FAKE_ACP_SESSION_OPTIONS: "1",
        FAKE_ACP_SESSION_OPTION_REJECTED_VALUE: "plan",
      },
    });
    requesting(session, { approach: "plan" });
    await harness.turn(session, "hello");
    expect(ofType(harness, "provider/warning").at(-1)).toMatchObject({
      summary: "The agent did not apply Approach",
      details: expect.stringContaining("approach unavailable: plan"),
    });
    expect(states(harness, "bb/session-options").at(-1)).toMatchObject({
      options: [{ id: "approach", value: "build" }, { id: "web" }],
    });
  });

  it("rewrites a leading bb skill command the agent did not advertise, so the agent does not swallow it as an unknown command", async () => {
    const log = join(createHarness().dir, "prompts.log");
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_PROMPT_LOG: log },
    });
    const skillTurn = (name: string): PromptInput[] => [
      {
        type: "text",
        text: `/${name} summarize the repo`,
        mentions: [
          {
            start: 0,
            end: name.length + 1,
            resource: {
              kind: "command",
              trigger: "/",
              name,
              source: "skill",
              origin: "user",
              label: name,
              argumentHint: null,
            },
          },
        ],
      },
    ];
    let count = 0;
    const run = async (input: PromptInput[]) => {
      count += 1;
      const before = ofType(harness, "turn/completed").length;
      await session.startTurn({
        clientRequestId: `req_skill_${count}`,
        input,
        options: harness.execution,
      });
      await expect
        .poll(() => ofType(harness, "turn/completed").length)
        .toBeGreaterThan(before);
    };
    await run(skillTurn("example-skill"));
    await harness.turn(session, "advertise-commands");
    await run(skillTurn("example-skill"));
    await run(skillTurn("review"));
    expect(jsonLines(log)).toEqual([
      "/example-skill summarize the repo",
      "advertise-commands",
      'Use the bb skill "example-skill": summarize the repo',
      "/review summarize the repo",
    ]);
  });

  it("publishes nothing for an agent with no commands or options", async () => {
    const { harness, session } = await tracked.start();
    await harness.turn(session, "hello");
    expect(ofType(harness, "thread/extensionState/updated")).toEqual([]);
  });
});
