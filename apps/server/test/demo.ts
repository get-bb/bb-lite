import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { createTestServer, GIT_ENV } from "./helpers.js";
import { createProject, type TestServer } from "./watch.js";

type Environment = Record<"id" | "projectId" | "hostId" | "path", string>;
type Files = Record<string, string | Uint8Array>;

export function git(cwd: string, ...args: string[]): string {
  const options = { cwd, env: GIT_ENV, encoding: "utf8" } as const;
  return execFileSync("git", args, options).trim();
}

export function write(root: string, files: Files): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
}

export function insertEnvironment(
  { ctx }: TestServer,
  { id, projectId, hostId, path }: Environment,
  isGitRepo = 1,
): void {
  const values = [id, projectId, hostId, path, isGitRepo];
  ctx.db.run(
    `INSERT INTO environments
       (id, project_id, host_id, path, is_git_repo, status,
        environment_provider_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ready', 'project-checkout', 1, 1)`,
    ...values,
  );
}

export async function createDemo() {
  const server = await createTestServer({}, { realWorkspace: true });
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "bb-demo-")));
  onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
  write(repo, {
    "README.md": "# demo\n",
    "src/a.ts": "export const a = 1;\n",
    "src/index.html": "<p>hi</p>\n",
    ".bb/skills/ship/SKILL.md": "---\ndescription: Ship it\n---\n",
  });
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "initial");
  const { hostId } = server.ctx.config;
  const { id: projectId } = await createProject(server, "demo", repo);
  insertEnvironment(server, { id: "env_demo", projectId, hostId, path: repo });
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.url}/api/v1${path}`, init);
  const send = (path: string, body: unknown, method = "POST") => {
    const headers = { "content-type": "application/json" };
    return request(path, { method, headers, body: JSON.stringify(body) });
  };
  const read = async (path: string): Promise<unknown> =>
    (await request(path)).json();
  const matches = async (path: string, shape: object): Promise<void> =>
    expect(await read(path), path).toMatchObject(shape);
  return { server, repo, projectId, hostId, request, send, read, matches };
}
