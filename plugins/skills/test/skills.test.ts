import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localRunnerFor } from "@bb/server-kit/runners/local";
import { expect, it, onTestFinished } from "vitest";
import { createEchoAdapter } from "../../provider-echo/runner/echo.js";
import { createEchoServer } from "../../../apps/server/test/helpers.js";
import skillsRunner from "../runner.js";

type Skill = { id: string; source: string; enabled: boolean; path: string };

function skillDir(root: string, name: string, description: string) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const text = `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
  writeFileSync(join(directory, "SKILL.md"), text);
  writeFileSync(join(directory, "notes.txt"), "extra");
  return directory;
}

async function setup() {
  const server = await createEchoServer();
  const local = localRunnerFor(server.ctx.config, {
    adapters: [createEchoAdapter()],
    parts: [{ id: "skills", entry: skillsRunner }],
  });
  onTestFinished(local.shutdown);
  server.ctx.runners.connect(server.ctx.config.hostId, local.connect);
  const op = async <T>(name: string, input: object, status = 200) => {
    const response = await server.send(`/ops/${name}`, input);
    const body = (await response.json()) as { result: T };
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body.result;
  };
  const list = () => op<Skill[]>("skills.list", {});
  return { ...server, op, list };
}

it("installs a skill from a directory, reads, disables and removes it", async () => {
  const { op, list, ctx } = await setup();
  const source = mkdtempSync(join(tmpdir(), "bb-skill-src-"));
  const directory = skillDir(source, "greeter", "Say hello");

  const installed = await op<Skill>("skills.install", { source: directory });
  expect(installed).toMatchObject({ id: "installed:greeter", enabled: true });
  expect(await list()).toContainEqual(
    expect.objectContaining({ id: "installed:greeter", source: "installed" }),
  );
  expect(installed.path).toBe(
    join(ctx.config.dataDir, "skills", "greeter", "SKILL.md"),
  );

  const read = await op<{ content: string; files: string[] }>("skills.get", {
    id: "greeter",
  });
  expect(read.content).toContain("# greeter");
  expect(read.files).toEqual(["notes.txt", "SKILL.md"]);

  await op("skills.install", { source: directory }, 409);

  await op("skills.disable", { id: "greeter" });
  const skillsRoot = join(ctx.config.dataDir, "skills");
  expect(existsSync(join(skillsRoot, ".disabled", "greeter"))).toBe(true);
  expect(await list()).toContainEqual(
    expect.objectContaining({ id: "installed:greeter", enabled: false }),
  );
  await op("skills.enable", { id: "installed:greeter" });
  expect(existsSync(join(skillsRoot, "greeter", "SKILL.md"))).toBe(true);

  await op("skills.uninstall", { id: "greeter" });
  expect(existsSync(join(skillsRoot, "greeter"))).toBe(false);
  await op("skills.get", { id: "greeter" }, 404);
});

it("installs a named skill from a git repository", async () => {
  const { op } = await setup();
  const repo = mkdtempSync(join(tmpdir(), "bb-skill-repo-"));
  skillDir(join(repo, "skills"), "linter", "Lint things");
  const git = (...args: string[]) =>
    promisify(execFile)("git", args, { cwd: repo });
  await git("init", "-q");
  await git("add", ".");
  await git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );

  const installed = await op<Skill>("skills.install", {
    source: `file://${repo}`,
    skill: "linter",
  });
  expect(installed).toMatchObject({ id: "installed:linter" });
});

it("hides a disabled project skill from the composer commands", async () => {
  const { op, project, directory, request } = await setup();
  skillDir(join(directory, ".bb", "skills"), "deploy", "Ship it");
  const projectId = project.id;
  const listed = await op<Skill[]>("skills.list", { projectId });
  expect(listed).toContainEqual(
    expect.objectContaining({ id: "project:deploy", source: "project" }),
  );
  const commands = async () => {
    const path = `/projects/${projectId}/commands?provider=echo`;
    const body = (await (await request(path)).json()) as {
      commands: { name: string }[];
    };
    return body.commands.map(({ name }) => name);
  };
  expect(await commands()).toContain("deploy");
  await op("skills.disable", { id: "project:deploy", projectId });
  expect(await commands()).not.toContain("deploy");
  expect(await op<Skill[]>("skills.list", { projectId })).toContainEqual(
    expect.objectContaining({ id: "project:deploy", enabled: false }),
  );
});

it("searches a configured registry", async () => {
  const { op, send } = await setup();
  const queries: string[] = [];
  const registry = http.createServer((request, response) => {
    queries.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    const entry = {
      id: "acme/skills/pdf",
      slug: "pdf",
      name: "pdf",
      source: "acme/skills",
      installs: 3,
    };
    response.end(JSON.stringify({ data: [entry] }));
  });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  onTestFinished(() => void registry.close());
  const { port } = registry.address() as AddressInfo;

  expect(await op("skills.search", { query: "pdf" })).toEqual([]);
  const registryUrl = `http://127.0.0.1:${port}`;
  const saved = await send(
    "/plugins/skills/settings",
    { values: { registryUrl } },
    "PUT",
  );
  expect(saved.status).toBe(200);
  const found = await op<object[]>("skills.search", { query: "pdf" });
  expect(found).toEqual([
    expect.objectContaining({
      id: "acme/skills/pdf",
      sourceId: "registry",
      install: "https://github.com/acme/skills.git",
      skill: "pdf",
    }),
  ]);
  expect(queries[0]).toContain("/api/v1/skills/search?q=pdf");
});

it("acts on the machine the CLI runs on", async () => {
  const { send } = await setup();
  const source = mkdtempSync(join(tmpdir(), "bb-skill-src-"));
  const directory = skillDir(source, "roamer", "Travel");
  const cli = async (argv: string[], hostId?: string) => {
    const input = { argv, ...(hostId === undefined ? {} : { hostId }) };
    const response = await send("/plugins/skills/cli", input);
    return (await response.json()) as { exitCode: number; stderr: string };
  };
  const elsewhere = await cli(["install", directory], "host_far");
  expect(elsewhere.exitCode).not.toBe(0);
  expect((await cli(["install", directory])).exitCode).toBe(0);
});
