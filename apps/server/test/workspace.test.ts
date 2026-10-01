import { appendFileSync, existsSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { environmentSchema } from "@bb/domain";
import { expect, it } from "vitest";
import { insertHost } from "../src/db/hosts.js";
import { createDemo, git, insertEnvironment, write } from "./demo.js";
import { insertThread, watchChanges } from "./watch.js";

const env = "/environments/env_demo";
const uncommitted = "target=uncommitted";
const commit = { action: "commit" };
const attach = "UPDATE threads SET environment_id = ?";

it("reports status, diffs and commits for a checkout with mixed changes", async () => {
  const { server, repo, read, matches, send } = await createDemo();
  const changed = await watchChanges(server);
  write(repo, { "src/a.ts": "export const a = 2;\n", "staged.txt": "new\n" });
  write(repo, { "notes.md": "untracked\n" });
  git(repo, "add", "staged.txt");
  expect(environmentSchema.parse(await read(env)).branchName).toBeNull();
  const workingTree = { state: "dirty_uncommitted", insertions: 3 };
  const workspace = { workingTree, branch: { currentBranch: "main" } };
  await matches(`${env}/status`, { outcome: "available", workspace });
  await changed("environment", "metadata-changed");
  await matches(env, { branchName: "main", defaultBranch: "main" });

  const files = [
    { path: "src/a.ts", changeKind: "modified", additions: 1, deletions: 1 },
    { path: "staged.txt", origin: "tracked", changeKind: "added" },
    { path: "notes.md", origin: "untracked", changeKind: "added" },
  ];
  const listed = { outcome: "available", truncated: false, files };
  await matches(`${env}/diff/files?${uncommitted}`, listed);
  const wanted = { target: { type: "uncommitted" }, paths: ["src/a.ts"] };
  const patch = await (await send(`${env}/diff/patch`, wanted)).text();
  expect(patch).toMatch(/"outcome":"available".*\+export const a = 2;/u);
  const before = { content: "export const a = 1;\n", sizeBytes: 20 };
  const old = `${env}/diff/file?${uncommitted}&side=old&path=src/a.ts`;
  await matches(old, before);
  const whole = await read(`${env}/diff?${uncommitted}`);
  expect(JSON.stringify(whole)).toContain("+untracked");

  const committed = await send(`${env}/actions`, commit);
  const made = { ok: true, commitSubject: "bb: automated commit" };
  expect(await committed.json()).toMatchObject(made);
  await changed("environment", "work-status-changed", "git-refs-changed");
  const clean = { workingTree: { state: "clean", files: [] } };
  await matches(`${env}/status`, { workspace: clean });
  const again = await send(`${env}/actions`, commit);
  const refused = [again.status, await again.json()];
  expect(refused).toMatchObject([409, { code: "no_changes" }]);
});

it("serves file bytes with ranges, validators and confinement", async () => {
  const { server, repo, projectId, hostId, request } = await createDemo();
  const big = Buffer.alloc(1_300_000).map((_, at) => at % 251);
  const size = String(big.length);
  write(repo, { "big.bin": big, "src/a.ts": "changed\n" });
  symlinkSync("/etc/hosts", join(repo, "escape"));
  const file = (path: string, headers = {}, method = "GET") =>
    request(`${env}/files/${path}`, { method, headers });
  const bytes = async (response: Response) =>
    Buffer.from(await response.arrayBuffer());

  const full = await file("big.bin");
  const etag = full.headers.get("etag") ?? "";
  expect(Object.fromEntries(full.headers)).toMatchObject({
    "accept-ranges": "bytes",
    "cache-control": "private, no-cache",
    "content-length": size,
    "content-security-policy": "sandbox allow-scripts",
    "content-type": "application/octet-stream",
  });
  expect(`${full.status} ${etag}`).toMatch(/^200 W\/"file-[0-9a-f]{64}"$/u);
  expect((await bytes(full)).equals(big)).toBe(true);
  const part = await file("big.bin", { range: "bytes=524280-524299" });
  const span = part.headers.get("content-range");
  expect(`${part.status} ${span}`).toBe(`206 bytes 524280-524299/${size}`);
  expect((await bytes(part)).equals(big.subarray(524280, 524300))).toBe(true);
  const beyond = await file("big.bin", { range: "bytes=9999999-" });
  const total = beyond.headers.get("content-range");
  expect(`${beyond.status} ${total}`).toBe(`416 bytes */${size}`);
  const fresh = await file("big.bin", { "if-none-match": etag });
  const head = await file("big.bin", { range: "bytes=0-1" }, "HEAD");
  const length = head.headers.get("content-length");
  const unread = [fresh.status, head.status, length, await head.text()];
  expect(unread).toEqual([304, 200, size, ""]);

  const html = await file("src/index.html");
  const page = [html.headers.get("cache-control"), "text/html; charset=utf-8"];
  expect(page).toEqual(["no-store", html.headers.get("content-type")]);
  const committed = `${env}/revisions/HEAD/files/src/a.ts`;
  expect(await (await request(committed)).text()).toBe("export const a = 1;\n");
  const outside = ["files/..%2F..%2Fetc%2Fhosts", "files/escape"];
  for (const route of [...outside, "revisions/main~1/files/src/a.ts"]) {
    expect((await request(`${env}/${route}`)).status, route).toBe(400);
  }
  expect((await file("missing")).status).toBe(404);

  insertThread(server, "thr_demo", projectId);
  server.ctx.db.run(attach, "env_demo");
  for (const route of [
    `/projects/${projectId}/files/README.md`,
    `/projects/${projectId}/hosts/${hostId}/files/README.md`,
    `/hosts/${hostId}/files${repo}/README.md`,
    `/threads/thr_demo/host-files${repo}/README.md`,
  ]) {
    expect(await (await request(route)).text(), route).toBe("# demo\n");
  }

  const { readFileChunk } = server.runner.script;
  server.runner.script.readFileChunk = async (args) => {
    if (args.offset > 0) appendFileSync(join(repo, "big.bin"), "more");
    return readFileChunk!(args);
  };
  await expect(file("big.bin").then(bytes)).rejects.toThrow();
});

it("searches paths and reads branches, commands and folders", async () => {
  const { repo, projectId, hostId, matches, read, send } = await createDemo();
  git(repo, "branch", "feature");
  write(repo, { "src/reader.ts": "", "docs/thread.md": "" });
  const project = `/projects/${projectId}`;
  const readme = { kind: "file", path: "README.md", positions: [0, 1, 2, 3] };
  const paths = [readme, { path: "src/reader.ts" }, {}];
  const both = "includeFiles=true&includeDirectories=true";
  await matches(`${project}/paths?query=read&${both}`, { paths });
  const folders = "includeFiles=false&includeDirectories=true&query=sr";
  const src = { kind: "directory", path: "src" };
  await matches(`${env}/paths?${folders}`, { paths: [src], truncated: false });

  await matches(`${project}/branches?hostId=${hostId}&selectedBranch=feature`, {
    checkout: { kind: "branch", branchName: "main" },
    branches: ["main", "feature"],
    selectedBranch: { name: "feature", kind: "local" },
    defaultWorktreeBaseBranch: "main",
    hasUncommittedChanges: true,
  });
  await matches(`${env}/diff/branches?query=feat`, { branches: ["feature"] });
  const skill = { name: "ship", source: "skill", origin: "project" };
  const commands = [{ ...skill, description: "Ship it", argumentHint: null }];
  expect(await read(`${project}/commands?provider=echo`)).toEqual({ commands });

  const entries = [{ name: "docs" }, { name: "src" }, { name: "README.md" }];
  const browsed = { directory: repo, parent: dirname(repo), entries };
  const browse = `/hosts/${hostId}/directory?path=${encodeURIComponent(repo)}`;
  await matches(browse, browsed);
  const made = join(repo, "made");
  const exist = await send(`/hosts/${hostId}/paths/exist`, { paths: [made] });
  expect(await exist.json()).toEqual({ existence: { [made]: false } });
  const mkdir = await send("/files/mkdir", { path: made });
  expect([await mkdir.json(), existsSync(made)]).toEqual([{ ok: true }, true]);
});

it("renames and deletes environments once their threads are gone", async () => {
  const { server, projectId, matches, request, send } = await createDemo();
  const changed = await watchChanges(server);
  const renamed = await send(env, { name: "Docs" }, "PATCH");
  expect(await renamed.json()).toMatchObject({ id: "env_demo", name: "Docs" });
  await changed("environment", "metadata-changed");
  insertThread(server, "thr_demo", projectId);
  server.ctx.db.run(attach, "env_demo");
  const remove = { method: "DELETE" };
  const archive = `${env}/archive-threads`;
  expect((await request(env, remove)).status).toBe(409);
  const swept = await (await send(archive, {})).json();
  expect(swept).toEqual({ ok: true, archivedThreadIds: ["thr_demo"] });
  const archived = "SELECT id FROM threads WHERE archived_at IS NOT NULL";
  expect(server.ctx.db.all(archived)).toEqual([{ id: "thr_demo" }]);
  server.ctx.db.run("DELETE FROM threads");
  expect((await request(env, remove)).status).toBe(200);
  await changed("environment", "environment-deleted");
  await matches(env, { code: "environment_not_found" });
});

it("answers with outcomes when git, a machine or a folder is missing", async () => {
  const { server, repo, projectId, hostId, matches, request, send } =
    await createDemo();
  insertHost(server.ctx.db, { id: "host_away", name: "away", phase: "active" });
  const away = { id: "env_away", hostId: "host_away", path: "/repos/away" };
  insertEnvironment(server, { ...away, projectId });
  const missing = { id: "env_gone", hostId, path: join(repo, "gone") };
  insertEnvironment(server, { ...missing, projectId });
  const plain = { id: "env_plain", hostId, path: join(repo, "src") };
  insertEnvironment(server, { ...plain, projectId }, 0);

  const failure = { code: "unknown", workspacePath: "/repos/away" };
  const offline = { outcome: "unavailable", failure };
  await matches("/environments/env_away/status", offline);
  await matches(`/environments/env_away/diff/files?${uncommitted}`, offline);
  const lost = { code: "path_not_found", workspacePath: missing.path };
  const absent = { outcome: "unavailable", failure: lost };
  await matches("/environments/env_gone/status", absent);
  const skipped = { outcome: "not_applicable", reason: "non_git_environment" };
  await matches("/environments/env_plain/status", skipped);
  await matches(`/environments/env_plain/diff?${uncommitted}`, skipped);

  const refused = await send("/environments/env_away/actions", commit);
  const details = { kind: "workspace_unavailable", failure };
  const unavailable = [409, { code: "workspace_unavailable", details }];
  expect([refused.status, await refused.json()]).toMatchObject(unavailable);
  const bytes = await request("/environments/env_away/files/README.md");
  const down = [502, { code: "host_unavailable" }];
  expect([bytes.status, await bytes.json()]).toMatchObject(down);
});
