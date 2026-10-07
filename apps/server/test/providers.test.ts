import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AvailableModel } from "@bb/domain";
import { pluginSettingsResponseSchema } from "@bb/server-contract";
import { expect, it } from "vitest";
import { resolveContributedEnvironment } from "../src/machine-environment.js";
import { providerOptionsFor } from "../src/providers/settings.js";
import { createProject, createTestServer, watchChanges } from "./helpers.js";

function model(id: string): AvailableModel {
  const efforts = { supportedReasoningEfforts: [], isDefault: false };
  const text = { model: id, displayName: id, description: id };
  return { id, ...text, ...efforts, defaultReasoningEffort: "medium" };
}

it("caches model catalogs and merges custom models", async () => {
  const server = await createTestServer();
  const { api, clock, ctx, runner } = server;
  const changed = await watchChanges(server);
  const route = api.system["execution-options"];
  const query = { providerId: "codex" };
  const options = async () => (await route.$get({ query })).json();
  const modelLoadError = { providerId: "codex", code: "failed" };
  expect(await options()).toMatchObject({ models: [], modelLoadError });
  let models = [model("gpt-5")];
  const selectedOnlyModels = [model("gpt-old")];
  runner.script.listModels = async () => ({ models, selectedOnlyModels });
  const named = { displayName: "Mine", description: "Early access" };
  const mine = { providerId: "codex", model: "mine", ...named };
  const promoted = { ...mine, model: "gpt-old" };
  const customModels = [promoted, mine, { ...mine, providerId: "echo" }];
  const config = join(ctx.config.dataDir, "config.json");
  writeFileSync(config, JSON.stringify({ customModels }));
  clock.now += 30_000;
  const loaded = await options();
  const names = loaded.models.map(({ displayName }) => displayName).join();
  expect(names).toBe("gpt-5,gpt-old,Mine");
  expect(loaded.models[2]?.description).toBe("Early access");
  expect(loaded.selectedOnlyModels).toEqual([]);
  expect(loaded.modelLoadError).toBeNull();
  const providerIds = loaded.providers.map(({ id }) => id).join();
  expect(providerIds).toBe("codex,claude-code,echo");
  models = [model("gpt-6")];
  clock.now += 10 * 60_000 - 1;
  expect((await options()).models[0]?.id).toBe("gpt-5");
  clock.now += 1;
  await options();
  await changed("host", "provider-model-catalog-changed");
  expect((await options()).models[0]?.id).toBe("gpt-6");
  expect(runner.calls.map(({ method }) => method)).toHaveLength(3);
});

it("disables providers and turns their toggles into options", async () => {
  const server = await createTestServer();
  const { api, ctx, url } = server;
  const changed = await watchChanges(server);
  const enabled = api.system.providers[":id"].enabled;
  const off = { param: { id: "codex" }, json: { enabled: false } };
  const [codex] = await (await enabled.$put(off)).json();
  expect(codex).toMatchObject({ enabled: false, pluginId: "provider-codex" });
  await changed("system", "config-changed");
  const logo = await fetch(`${url}/api/v1/system/providers/claude-code/logo`);
  expect(logo.headers.get("content-type")).toBe("image/svg+xml");
  const defaults = { memoryEnabled: true, providerSubagentsEnabled: true };
  expect(providerOptionsFor(ctx.db, "codex")).toEqual(defaults);
  const body = JSON.stringify({ values: { subagentsDisabled: true } });
  const settings = `${url}/api/v1/plugins/provider-codex/settings`;
  const saved = await fetch(settings, { method: "PUT", body });
  const { values } = pluginSettingsResponseSchema.parse(await saved.json());
  expect(values).toEqual({ memoryEnabled: true, subagentsDisabled: true });
  await changed("system", "config-changed");
  const updated = { ...defaults, providerSubagentsEnabled: false };
  expect(providerOptionsFor(ctx.db, "codex")).toEqual(updated);
});

it("keeps environment variable values encrypted and write-only", async () => {
  const server = await createTestServer();
  const { api, ctx } = server;
  const changed = await watchChanges(server);
  const param = { id: (await createProject(server, "alpha")).id };
  const set = (value: string | null, name = "API_KEY", note = "n") => {
    return { variables: [{ name, value, note }] };
  };
  const everywhere = api.settings["machine-environment"];
  const scoped = api.projects[":id"]["machine-environment"];
  await everywhere.$put({ json: set("s3cret-global") });
  await changed("system", "config-changed");
  await scoped.$put({ param, json: set("s3cret-own") });
  await changed("system", "config-changed");
  const kept = await everywhere.$put({ json: set(null, "API_KEY", "kept") });
  await changed("system", "config-changed");
  const hidden = { name: "API_KEY", value: null, secret: true };
  const variables = [{ ...hidden, note: "kept" }];
  expect(await kept.json()).toMatchObject({ variables });
  const view = await (await scoped.$get({ param })).json();
  expect(view).toMatchObject({ inheritedVariables: variables });
  const unsaved = await everywhere.$put({ json: set(null, "OTHER") });
  expect(unsaved.status).toBe(409);
  const stored = ctx.db.all("SELECT * FROM environment_variables");
  expect(JSON.stringify([stored, view])).not.toContain("s3cret");
  const key = statSync(join(ctx.config.dataDir, "machine-environment-key"));
  expect(key.mode & 0o777).toBe(0o600);
  const everywhereEnv = await resolveContributedEnvironment(ctx, null);
  const projectEnv = await resolveContributedEnvironment(ctx, param.id);
  const resolved = [everywhereEnv.API_KEY, projectEnv.API_KEY].join();
  expect(resolved).toBe("s3cret-global,s3cret-own");
});
