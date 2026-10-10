import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingInteractionResolution } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { createHarness } from "./adapter-harness.js";
import {
  begin,
  jsonLines,
  messages,
  ofType,
  trackSessions,
  until,
} from "./lifecycle-helpers.js";

const tracked = trackSessions();

describe("acp adapter: questions the agent asks", () => {
  it("tells the agent it can ask form questions", async () => {
    const log = join(createHarness().dir, "requests.log");
    await tracked.start({ env: { FAKE_ACP_REQUEST_LOG: log } });
    const initialize = jsonLines<{
      method?: string;
      params?: Record<string, unknown>;
    }>(log).find((request) => request.method === "initialize");
    expect(initialize?.params?.["clientCapabilities"]).toMatchObject({
      elicitation: { form: {} },
    });
  });

  it("shows a form question as a user question and returns typed answers to the agent", async () => {
    const { harness, session } = await tracked.start({
      answer: () => ({
        kind: "user_answer",
        answers: {
          strategy: { selected: ["balanced"] },
          dryRun: { selected: ["true"] },
        },
      }),
    });
    await harness.turn(session, "ask-form");
    expect(harness.interactions).toMatchObject([
      {
        kind: "user_question",
        questions: [
          {
            id: "strategy",
            prompt: "How should I proceed?\n\nStrategy",
            options: [{ value: "conservative" }, { value: "balanced" }],
          },
          { id: "dryRun", options: [{ value: "true" }, { value: "false" }] },
        ],
      },
    ]);
    expect(messages(harness).join("")).toContain(
      'elicitation:{"action":"accept","content":{"strategy":"balanced","dryRun":true}}',
    );
  });

  it("declines a form it cannot show and says why", async () => {
    const { harness, session } = await tracked.start();
    await harness.turn(session, "ask-form-too-large");
    expect(messages(harness).join("")).toContain(
      'elicitation:{"action":"decline"}',
    );
    expect(ofType(harness, "provider/warning").at(-1)).toMatchObject({
      summary: "The agent asked a question bb could not show",
      details:
        "The request was declined because the form has 5 fields and bb shows at most 4.",
    });
    expect(harness.interactions).toEqual([]);
  });

  it("answers a pending question with cancel when the turn is stopped", async () => {
    const log = join(createHarness().dir, "requests.log");
    const { harness, session } = await tracked.start({
      env: { FAKE_ACP_REQUEST_LOG: log },
    });
    harness.host.requestInteraction = ({ payload }) => {
      harness.interactions.push(payload);
      return new Promise<PendingInteractionResolution>(() => undefined);
    };
    await begin(harness, session, "ask-form");
    await until(() => expect(harness.interactions).toHaveLength(1));
    await session.interrupt();
    await until(() =>
      expect(readFileSync(log, "utf8")).toContain(
        '{"elicitationResult":{"action":"cancel"}}',
      ),
    );
  });
});
