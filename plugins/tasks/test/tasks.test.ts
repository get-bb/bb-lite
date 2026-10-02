import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  createThreadServer,
  events,
} from "../../../apps/server/test/thread-harness.js";
import { initializeTasksSchema } from "../db/schema.js";
import type {
  Comment,
  Label,
  Project,
  Task,
  TaskDetail,
} from "../shared/contract.js";

type Row = Record<string, unknown>;
interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");
const ulid = (suffix: string): string => `01J8ZZZZZZZZZZZZZZZZZZZZ${suffix}`;

async function tasksServer() {
  const server = await createThreadServer();
  const base = `${server.url}/api/v1/plugins/tasks`;
  const post = (path: string, body: unknown = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const rpc = async <Result = Row>(
    method: string,
    input: unknown = null,
  ): Promise<Result> => {
    const response = await post(`/rpc/${method}`, input);
    const body = (await response.json()) as {
      result: Result;
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const cli = async (line: string, scope: Row = {}) => {
    const words = line.match(/'[^']*'|\S+/gu) ?? [];
    const argv = words.map((word) => word.replace(/^'|'$/gu, ""));
    const response = await post("/cli", { argv, ...scope });
    const output = JSON.parse((await response.text()).trim()) as CliOutput;
    await server.settle();
    const json = <Shape = Row>(): Shape => JSON.parse(output.stdout) as Shape;
    return { ...output, json };
  };
  const seed = async () => {
    const tracker = { name: "bb", prefix: "BB", color: "slateblue" };
    const linked = { ...tracker, linkedBbProjectId: "proj_1" };
    const created = await rpc<{ project: Project }>("createProject", linked);
    const projectId = created.project.id;
    const tag = { projectId, name: "bug", color: "indianred" };
    const { label } = await rpc<{ label: Label }>("createLabel", tag);
    const input = { projectId, title: "Fix it", labelIds: [label.id] };
    const { task } = await rpc<{ task: Task }>("createTask", input);
    return { project: created.project, label, task };
  };
  const detail = async (taskKey: string): Promise<TaskDetail> =>
    (await rpc<{ detail: TaskDetail }>("taskDetail", { taskKey })).detail;
  return { ...server, base, post, rpc, cli, seed, detail };
}

it("round-trips tasks, labels, comments and mentions over rpc", async () => {
  const { ctx, rpc, seed, detail, socket, url } = await tasksServer();
  const client = await socket();
  const { project, label, task } = await seed();
  expect(task).toMatchObject({ key: "BB-1", status: "backlog", number: 1 });
  const signal = await client.next(({ type }) => type === "plugin-signal");
  expect(signal).toMatchObject({ pluginId: "tasks" });

  const child = { projectId: project.id, parentTaskId: task.id };
  const part = { ...child, title: "Part one", status: "todo" };
  const { task: subtask } = await rpc<{ task: Task }>("createTask", part);
  const grandchild = { ...child, parentTaskId: subtask.id, title: "Too deep" };
  await expect(rpc("createTask", grandchild)).rejects.toThrow("one level");
  const foreign = { taskId: task.id, labelIds: [ulid("ZZ")] };
  await expect(rpc("updateTask", foreign)).rejects.toThrow("must belong");

  const search = `${url}/api/v1/plugins/mentions/search?q=fix&projectId=proj_1`;
  const { groups } = (await (await fetch(search)).json()) as { groups: Row[] };
  const itemId = `task:${task.id}`;
  const item = { itemId, title: "BB-1 · Fix it", subtitle: "bb · Backlog" };
  expect(groups).toMatchObject([{ providerId: "task", items: [item] }]);
  const context = await ctx.plugins.resolveMention("tasks", itemId);
  expect(context).toContain("- Labels: bug\n- Project: bb");
  expect(context).toContain("first run: bb tasks attach BB-1");

  const moved = { taskId: task.id, status: "in_progress", labelIds: [] };
  await rpc("updateTask", moved);
  const said = { taskId: task.id, body: "Looks good", notify: true };
  await rpc("createComment", said);
  const found = await detail("bb-1");
  expect(found.task).toMatchObject({ status: "in_progress", labelIds: [] });
  expect(found.subtasks.map((entry) => entry.key)).toEqual(["BB-2"]);
  expect(found.labels).toEqual([label]);
  const activity = found.comments.map(({ kind, body }) => [kind, body]);
  expect(activity).toEqual([
    ["system", "Status changed to In Progress by You"],
    ["system", "Labels cleared by You"],
    ["user", "Looks good"],
  ]);
  expect(found.comments[2]).toMatchObject({ notifiedCount: 0, provider: null });
  expect((await detail("BB-2")).parent).toMatchObject({ key: "BB-1" });

  const top = { parentTaskId: null, statuses: ["in_progress", "done"] };
  const listed = await rpc<{ tasks: Task[] }>("listTasks", top);
  expect(listed.tasks.map((entry) => entry.key)).toEqual(["BB-1"]);
  expect(await rpc("overview")).toMatchObject({
    projects: [{ prefix: "BB", nextTaskNumber: 3 }],
    summaries: [{ projectId: project.id, taskCount: 1, activeAgentCount: 0 }],
    openTaskCount: 2,
    activeTaskCount: 0,
  });
  await rpc("updateLabel", { labelId: label.id, name: "defect" });
  const renamed = { labels: [{ name: "defect", color: "indianred" }] };
  expect(await rpc("listLabels", {})).toMatchObject(renamed);
  const removed = await rpc("deleteLabel", { labelId: label.id });
  expect(removed).toEqual({ deleted: true });
});

it("serves the agent CLI with the original flags and JSON shapes", async () => {
  const server = await tasksServer();
  const { cli, seed } = server;
  await seed();
  const threadId = await server.spawn();
  const agent = { threadId, projectId: "proj_1" };
  const status = { name: "Tasks", version: "0.1.2" };
  expect((await cli("status --json")).json()).toEqual(status);
  const child = "create --title Child --description Spec --parent bb-1";
  expect((await cli(child, agent)).stdout).toBe("Created BB-2  Child");
  const made = await cli(
    "create --project BB --name Other --labels bug --json",
  );
  const createdKeys = ["task", "attachments", "failedAttachments"];
  expect(Object.keys(made.json())).toEqual(createdKeys);

  const moved = await cli("update BB-2 --status in_review --json", agent);
  const reviewed = { task: { key: "BB-2", status: "in_review" } };
  expect(moved.json()).toMatchObject(reviewed);
  expect((await cli("update BB-2")).stderr).toContain("no task changes");
  const said = await cli("comment BB-2 --body Done --json", agent);
  const { comment } = said.json<{ comment: Comment }>();
  expect(comment).toMatchObject({ kind: "agent", threadId, body: "Done" });
  expect(comment.authorName).toBe(`agent (${threadId})`);

  const attached = await cli("attach BB-2", agent);
  expect(attached.stdout).toBe(`Attached ${threadId} to BB-2`);
  expect((await cli("threads BB-2 --json")).json()).toMatchObject({
    task: { key: "BB-2" },
    taskThreads: [{ threadId, presetName: "Attached" }],
  });
  const shown = (await cli("get bb-2 --json")).json();
  const detailKeys = ["task", "project", "labels", "subtasks", "attachments"];
  const activityKeys = ["taskThreads", "comments"];
  expect(Object.keys(shown)).toEqual([...detailKeys, ...activityKeys]);
  expect(shown).toMatchObject({
    task: { parentTaskId: expect.any(String), description: "Spec" },
    comments: [{}, { body: "Done", provider: { id: "codex" } }],
  });
  const filtered = await cli("list --status in_review,done --json", agent);
  expect(filtered.json()).toMatchObject({
    tasks: [{ key: "BB-2", labels: [], agentsWorking: expect.any(Number) }],
    nextCursor: null,
    limit: 100,
  });
  expect((await cli("list")).stdout).toContain("BB-3  backlog");
  const projects = [{ prefix: "BB", linkedBbProjectId: "proj_1" }];
  expect((await cli("project list --json")).json()).toMatchObject({ projects });
  expect((await cli(`detach BB-2 --thread ${threadId}`)).exitCode).toBe(0);
  const missing = await cli("show BB-99 --json");
  const error = { code: "task_not_found", message: "task not found: BB-99" };
  expect([missing.exitCode, missing.json()]).toEqual([1, { ok: false, error }]);
});

it("stores attachments over http and through the CLI on both machines", async () => {
  const server = await tasksServer();
  const { base, cli, ctx, detail, post, rpc, runner, seed } = server;
  const { task } = await seed();
  const query = `taskId=${task.id}&fileName=..%2Fshot.png&mime=image%2Fpng`;
  const upload = (headers: Record<string, string>) => {
    const init = { method: "POST", headers, body: PNG };
    return fetch(`${base}/http/attachments/upload?${query}`, init);
  };
  expect((await upload({})).status).toBe(401);
  const { token } = (await (await post("/token")).json()) as { token: string };
  const uploaded = await upload({ "x-bb-plugin-token": token });
  const stored = (await uploaded.json()) as Record<string, string>;
  const { attachmentId, url } = stored;
  const download = "/api/v1/plugins/tasks/http/attachments/download";
  const expectedUrl = `${download}?attachmentId=${attachmentId}`;
  expect([uploaded.status, url]).toEqual([201, expectedUrl]);
  const downloaded = await fetch(`${server.url}${url}`);
  expect(downloaded.headers.get("content-type")).toBe("image/png");
  expect(downloaded.headers.get("content-disposition")).toContain("inline");
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(PNG);
  const blobs = join(ctx.config.dataDir, "plugins/tasks/blobs", attachmentId);
  expect(readFileSync(join(blobs, "shot.png"))).toEqual(PNG);

  const source = join(ctx.config.dataDir, "report.md");
  writeFileSync(source, "# Report");
  const added = await cli(`attachment add bb-1 --file ${source} --json`);
  const { attachment } = added.json<{ attachment: { id: string } & Row }>();
  expect(attachment).toMatchObject({ fileName: "report.md", isImage: false });
  const out = join(ctx.config.dataDir, "nested/copy.md");
  const fetched = await cli(`attachment get ${attachment.id} --out ${out}`);
  expect(fetched.stdout).toBe(`Saved report.md  ${out}`);
  expect(readFileSync(out, "utf8")).toBe("# Report");

  const threadId = await server.spawn();
  const remote = { content: PNG.toString("base64"), contentEncoding: "base64" };
  Object.assign(runner.script, {
    readFile: async () => ({ ...remote, sha256: "s" }),
    writeFile: async () => ({ outcome: "written", sha256: "s" }),
  });
  const agent = { threadId, cwd: "/repo/work" };
  const pushed = await cli("attachment add BB-1 --file a.png --json", agent);
  const image = { fileName: "a.png", mime: "image/png", sizeBytes: 10 };
  expect(pushed.json()).toMatchObject({ attachment: image });
  await cli(`attachment get ${attachment.id} --out ../x.md`, agent);
  const located = { path: "/repo/work/a.png", rootPath: undefined };
  expect(server.callsTo("readFile")).toContainEqual(located);
  const content = Buffer.from("# Report").toString("base64");
  const written = [{ path: "/repo/x.md", content }];
  expect(server.callsTo("writeFile")).toMatchObject(written);

  const description = `Before ![shot](${url}) after`;
  await rpc("updateTask", { taskId: task.id, description });
  expect((await detail("BB-1")).attachments).toHaveLength(3);
  await rpc("deleteAttachment", { attachmentId });
  const after = await detail("BB-1");
  expect(after.task.description).toBe("Before  after");
  const remaining = after.attachments.map((file) => file.fileName);
  expect(remaining).toEqual(["report.md", "a.png"]);
  expect((await fetch(`${server.url}${url}`)).status).toBe(404);
});

it("opens a database written by the original plugin unchanged", async () => {
  const { base, cli, ctx, post } = await tasksServer();
  const directory = join(ctx.config.dataDir, "plugins/tasks");
  const [folder, project, task, label] = ["F1", "P1", "T1", "B1"].map(ulid);
  const [comment, file, link, preset] = ["C1", "A1", "X1", "R1"].map(ulid);
  await post("/disable");
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(join(directory, `data.db${suffix}`), { force: true });
  }
  const legacy = new Database(join(directory, "data.db"));
  initializeTasksSchema(legacy);
  legacy.exec(`
    INSERT INTO folders VALUES ('${folder}', 'Work', NULL, 'then');
    INSERT INTO projects VALUES
      ('${project}', 'Legacy', 'OLD', 3, 'steelblue', '${folder}', 'proj_1', 'then');
    INSERT INTO tasks VALUES ('${task}', '${project}', 2, 'Old task', 'Spec',
      'in_review', 'high', '2026-12-24', NULL, 1024, 'then', 'then');
    INSERT INTO labels VALUES ('${label}', '${project}', 'bug', 'indianred');
    INSERT INTO task_labels VALUES ('${task}', '${label}');
    INSERT INTO comments VALUES ('${comment}', '${task}', 'agent', 'agent',
      NULL, 'thr_gone', 'Did it', 0, 'then');
    INSERT INTO attachments VALUES ('${file}', '${task}', NULL, 'note.txt',
      'text/plain', 5, 'blobs/${file}/note.txt', 0, 'then');
    INSERT INTO task_threads VALUES ('${link}', '${task}', 'thr_gone',
      'Attached', 'Old thread', 'idle', 'then', 'then');
    INSERT INTO presets VALUES ('${preset}', 'Codex high', 'codex', 'gpt-5',
      'high', 'full', 'Be careful', 0, 'then', 'new-worktree', 'main', NULL,
      'fast');
    INSERT INTO task_key_aliases VALUES ('ZZZ', 9, '${task}');
  `);
  legacy.close();
  mkdirSync(join(directory, "blobs", file), { recursive: true });
  writeFileSync(join(directory, "blobs", file, "note.txt"), "hello");
  await post("/enable");

  const projects = [{ prefix: "OLD", folderId: folder, nextTaskNumber: 3 }];
  expect((await cli("project list --json")).json()).toMatchObject({ projects });
  expect((await cli("show old-2 --json")).json()).toMatchObject({
    task: { key: "OLD-2", dueDate: "2026-12-24", labelIds: [label] },
    labels: [{ name: "bug" }],
    attachments: [{ id: file, fileName: "note.txt", sizeBytes: 5 }],
    taskThreads: [{ threadId: "thr_gone", liveStatus: "completed" }],
    comments: [{ body: "Did it", threadTitle: null, provider: null }],
  });
  const url = `${base}/http/attachments/download?attachmentId=${file}`;
  expect(await (await fetch(url)).text()).toBe("hello");
  const kept = { name: "Codex high", serviceTier: "fast", baseBranch: "main" };
  const presets = (await cli("preset list --json")).json();
  expect(presets).toMatchObject({ presets: [kept] });
  const next = await cli("create --project old --title 'New task'");
  expect(next.stdout).toBe("Created OLD-3  New task");
  await cli("update OLD-2 --status done --priority low");

  const stored = new Database(join(directory, "data.db"), { readonly: true });
  const column = (sql: string): unknown => stored.prepare(sql).pluck().get();
  expect([
    column("SELECT due_date FROM tasks WHERE number = 2"),
    column("SELECT folder_id FROM projects"),
    column("SELECT task_id FROM task_key_aliases"),
    column("SELECT COUNT(*) FROM schema_version"),
    column("SELECT revision > 0 FROM task_list_revision"),
  ]).toEqual(["2026-12-24", folder, task, 7, 1]);
  stored.close();
});

it("dispatches to a new thread, follows it and notifies its agent", async () => {
  const server = await tasksServer();
  const { cli, detail, rpc, rows, seed, submitted } = server;
  const { task } = await seed();
  const execution = "--provider codex --model gpt-test --reasoning high";
  const guard = "--permission full --instructions 'Work carefully'";
  const saved = await cli(`preset set 'Codex high' ${execution} ${guard}`);
  expect(saved.stdout).toContain("Saved preset Codex high");
  expect((await cli("preset set Other")).stderr).toContain("--provider");
  const sent = "dispatch bb-1 --preset 'codex HIGH' --json";
  const dispatched = await cli(`${sent} --instructions 'Be quick'`);
  const { threadId } = dispatched.json<{ threadId: string }>();
  const used = { task: { key: "BB-1" }, preset: { name: "Codex high" } };
  expect(dispatched.json()).toMatchObject(used);
  const threads = "SELECT origin_plugin_id, title, project_id FROM threads";
  const origin = { originPluginId: "tasks", projectId: "proj_1" };
  const spawned = [{ ...origin, title: "BB-1 · Fix it" }];
  expect(rows(`${threads} WHERE id = ?`, threadId)).toEqual(spawned);
  const [prompt] = submitted[0].input;
  const seedText = prompt.type === "text" ? prompt.text : "";
  expect(seedText).toContain("# BB-1 · Fix it\n\n## Task details");
  expect(seedText).toContain(`bb tasks comment BB-1 --body`);
  expect(seedText).toContain("## Preset instructions\n\nWork carefully");
  expect(seedText).toContain("## Additional instructions\n\nBe quick\n");
  const options = { model: "gpt-test", permissionMode: "full" };
  expect(submitted[0].options).toMatchObject(options);

  const linkStatus = async (): Promise<string[]> =>
    (await detail("BB-1")).threads.map((thread) => thread.liveStatus);
  const started = await detail("BB-1");
  expect(started.task.status).toBe("in_progress");
  const link = { threadId, presetName: "Codex high" };
  expect(started.threads).toMatchObject([link]);
  expect(started.comments.map((comment) => comment.body)).toEqual([
    "Status changed to In Progress · dispatched to Codex high",
    "Dispatched to Codex high",
  ]);
  await server.ingest(threadId, events.identity(), events.started("t1"));
  expect(await linkStatus()).toEqual(["working"]);
  await server.ingest(threadId, events.completed("t1"));
  expect(await linkStatus()).toEqual(["idle"]);

  await cli("comment BB-1 --body 'Halfway there'", { threadId });
  const reply = { taskId: task.id, body: "Use the new API", notify: true };
  const { comment } = await rpc<{ comment: Comment }>("createComment", reply);
  await server.settle();
  expect(comment.notifiedCount).toBe(1);
  const steer = "New comment on task BB-1 from You: Use the new API";
  expect(server.lastSubmit()[0]).toContain(steer);

  await server.ingest(threadId, events.started("t2"));
  await server.ingest(threadId, events.completed("t2", "failed"));
  expect(await linkStatus()).toEqual(["failed"]);
  const confirmed = { childThreadsConfirmed: true };
  await server.http("DELETE", `/threads/${threadId}`, confirmed);
  expect(await linkStatus()).toEqual(["completed"]);
  const notes = (await detail("BB-1")).comments.slice(-2);
  expect(notes.map((note) => note.body)).toEqual([
    `Thread "BB-1 · Fix it" failed · ${threadId}`,
    `Thread "BB-1 · Fix it" completed — final message posted · ${threadId}`,
  ]);
});
