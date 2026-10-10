import { sessions } from "@bb/plugin";
import { createPluginHarness } from "@bb/plugin/testing";
import { expect, it } from "vitest";
import {
  bbAccount,
  type AccountFetchOutput,
  type AccountStatus,
} from "bb-plugin-bb-account/contract.js";
import { bbAi, describeOverview } from "../contract.js";
import bbAiServer from "../server.js";

const SIGNED_IN: AccountStatus = {
  signedIn: true,
  handle: "ada",
  serverUrl: "https://ada.getbb.test",
  hosted: true,
  login: null,
};
const SIGNED_OUT = { ...SIGNED_IN, signedIn: false, handle: null };
const USAGE = {
  day: "2026-10-09",
  spentMicros: 120_000,
  limitMicros: 1_000_000,
  resetsAt: Date.UTC(2026, 9, 10),
};

async function setup(initial: AccountStatus) {
  const harness = createPluginHarness();
  let status = initial;
  const prompts: unknown[] = [];
  let reply: AccountFetchOutput = {
    status: 200,
    body: { text: "Fix the login form" },
  };
  const account = await harness.load("bb-account", (bb) => {
    bb.implement(bbAccount.status, () => status);
    bb.implement(bbAccount.fetch, (input) => {
      if (input.path === "/api/ai/v1/usage") {
        return { status: 200, body: USAGE };
      }
      prompts.push(input.body);
      return reply;
    });
  });
  const ai = await harness.load("bb-ai", bbAiServer);
  const services = () =>
    ai.api.entries(sessions.inference).map(({ item }) => item);
  const signIn = (next: AccountStatus) => {
    status = next;
    account.api.emit(bbAccount.changed, next);
  };
  const answer = (next: AccountFetchOutput) => {
    reply = next;
  };
  return { api: ai.api, services, signIn, answer, prompts };
}

const signal = new AbortController().signal;

it("writes thread titles through bb cloud for a signed-in account", async () => {
  const { services, prompts } = await setup(SIGNED_IN);
  const [service] = services();
  expect(service?.displayName).toBe("bb cloud");
  const title = await service?.complete("Title this task", { signal });
  expect(title).toBe("Fix the login form");
  expect(prompts).toEqual([{ prompt: "Title this task" }]);
});

it("is offered only while signed in and turned on", async () => {
  const { api, services, signIn } = await setup(SIGNED_OUT);
  expect(services()).toHaveLength(0);
  const before = await api.call(bbAi.status, {});
  expect(describeOverview(before)).toContain("Signed out");
  signIn(SIGNED_IN);
  expect(services()).toHaveLength(1);
  const off = await api.call(bbAi.update, { enabled: false });
  expect(off).toMatchObject({ ready: false, enabled: false });
  expect(services()).toHaveLength(0);
  const on = await api.call(bbAi.update, { enabled: true });
  expect(describeOverview(on)).toContain(
    "Usage: $0.12 of $1.00 today, resets 00:00 UTC",
  );
  expect(services()).toHaveLength(1);
});

it("steps aside once the daily limit is reached", async () => {
  const { api, services, answer } = await setup(SIGNED_IN);
  const resetsAt = Date.now() + 60_000;
  const error = {
    code: "budget_exhausted",
    message: "Out of budget",
    resetsAt,
  };
  answer({ status: 429, body: { error } });
  const [service] = services();
  await expect(service?.complete("Title", { signal })).rejects.toThrow(
    "Out of budget",
  );
  expect(services()).toHaveLength(0);
  const view = await api.call(bbAi.status, {});
  expect(view.message).toContain("Daily limit reached");
});
