import type { RunnerThreadEvent } from "@bb/runner";
import type { ThreadSessionOption } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { createThreadServer, type ThreadServer } from "./thread-harness.js";

const approach = (value: string): ThreadSessionOption => ({
  id: "approach",
  label: "Approach",
  type: "select",
  value,
  values: [
    { id: "plan", label: "Plan" },
    { id: "build", label: "Build" },
  ],
});
const web = (value: boolean): ThreadSessionOption => ({
  id: "web",
  label: "Web",
  type: "boolean",
  value,
});

function model(id: string, isDefault: boolean, options: ThreadSessionOption[]) {
  return {
    id,
    model: id,
    displayName: `Model ${id}`,
    description: id,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
    defaultReasoningEffort: "medium",
    isDefault,
    sessionOptions: options,
  };
}

function state(kind: string, payload: unknown): RunnerThreadEvent {
  return {
    type: "thread/extensionState/updated",
    scope: { kind: "thread" },
    providerThreadId: "provider-thread-1",
    kind,
    payload,
  } as RunnerThreadEvent;
}

const reportOptions = (server: ThreadServer, id: string, value: string) =>
  server.ingest(
    id,
    state("bb/session-options", { options: [approach(value), web(false)] }),
  );

const lastOptions = (server: ThreadServer) =>
  server.submitted.at(-1)?.options.sessionOptions;

function withCatalog(server: ThreadServer) {
  server.runner.script.listModels = async () => ({
    models: [
      model("alpha", true, [
        { ...approach("build"), values: [{ id: "build", label: "Build" }] },
      ]),
      model("beta", false, [approach("plan"), web(false)]),
    ],
    selectedOnlyModels: [],
  });
}

describe("thread session options", () => {
  it("sends choices made at creation with the first turn", async () => {
    const server = await createThreadServer();
    withCatalog(server);
    const id = await server.spawn({
      model: "beta",
      sessionOptions: { approach: "build" },
    });
    expect(lastOptions(server)).toEqual({ approach: "build" });
    await server.spawn({ model: "beta" });
    expect(server.submitted.at(-1)?.options).not.toHaveProperty(
      "sessionOptions",
    );
    const options = await server.http("GET", `/threads/${id}/session-options`);
    expect(options.body).toEqual({
      options: [],
      selections: { approach: "build" },
    });
    const refused = await server.api.threads.$post({
      json: {
        projectId: "proj_1",
        origin: "app",
        input: [{ type: "text", text: "hi", text_elements: [] }],
        environment: { type: "project-default" },
        startedOnBehalfOf: null,
        sessionOptions: { web: 1 },
      } as never,
    });
    expect(refused.status).toBe(400);
  });

  it("starts on a model that fits when the model is left to bb", async () => {
    const server = await createThreadServer();
    withCatalog(server);
    const id = await server.spawn({
      model: undefined,
      sessionOptions: { approach: "plan" },
    });
    expect(server.thread(id).model).toBe("beta");
  });

  it("refuses a named model that cannot run with the chosen options", async () => {
    const server = await createThreadServer();
    withCatalog(server);
    const response = await server.api.threads.$post({
      json: {
        projectId: "proj_1",
        origin: "app",
        input: [{ type: "text", text: "hi", text_elements: [] }],
        model: "alpha",
        environment: { type: "project-default" },
        startedOnBehalfOf: null,
        sessionOptions: { approach: "plan" },
      },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      "Model alpha cannot run with the chosen options",
    );
  });

  it("carries a pending choice until the provider reports it", async () => {
    const server = await createThreadServer();
    const id = await server.spawn();
    await server.runTurn(id, "turn-1");
    await reportOptions(server, id, "plan");
    const path = `/threads/${id}/session-options`;
    const bad = await server.http("PATCH", path, { set: { approach: "x" } });
    expect(bad.status).toBe(400);
    const set = await server.http("PATCH", path, {
      set: { approach: "build", web: true },
    });
    expect(set.body).toEqual({
      options: [approach("build"), web(true)],
      selections: { approach: "build", web: true },
    });
    const cleared = await server.http("PATCH", path, { clear: ["web"] });
    expect(cleared.body).toMatchObject({ selections: { approach: "build" } });
    await server.send(id, "auto", "next");
    expect(lastOptions(server)).toEqual({ approach: "build" });
    await reportOptions(server, id, "build");
    expect((await server.http("GET", path)).body).toEqual({
      options: [approach("build"), web(false)],
      selections: {},
    });
    await server.runTurn(id, "turn-2");
    await server.send(id, "auto", "again");
    expect(server.submitted.at(-1)?.options).not.toHaveProperty(
      "sessionOptions",
    );
  });

  it("serves the provider's latest slash commands", async () => {
    const server = await createThreadServer();
    const id = await server.spawn();
    const path = `/threads/${id}/provider-commands`;
    expect((await server.http("GET", path)).body).toEqual({ commands: [] });
    const commands = [{ name: "review", description: "Review the diff" }];
    await server.ingest(id, state("bb/provider-commands", { commands }));
    expect((await server.http("GET", path)).body).toEqual({ commands });
  });
});
