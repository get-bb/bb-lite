import { OWNER_USER_ID } from "@bb/domain";
import { expect, it } from "vitest";
import {
  createProject,
  createTestServer,
  insertThread,
} from "../../../apps/server/test/helpers.js";
import { promptLibrary } from "../contract.js";

type Server = Awaited<ReturnType<typeof createTestServer>>;

async function setup() {
  const server = await createTestServer();
  const project = await createProject(server, "web");
  insertThread(server, "thr_1", project.id);
  let sequence = 0;
  const history = (text: string, scope: "project" | "thread", at: number) => {
    sequence += 1;
    server.ctx.db.run(
      `INSERT INTO prompt_history_entries (id, project_id, thread_id, scope,
         request_sequence, user_id, input, created_at)
       VALUES (?, ?, 'thr_1', ?, ?, ?, ?, ?)`,
      `phist_${sequence}`,
      project.id,
      scope,
      sequence,
      OWNER_USER_ID,
      JSON.stringify([{ type: "text", text, mentions: [] }]),
      at,
    );
  };
  return { ...server, projectId: project.id, history };
}

async function cli({ url }: Server, ...argv: string[]) {
  const init = { method: "POST", body: JSON.stringify({ argv, cwd: "/" }) };
  const target = `${url}/api/v1/plugins/prompt-library/cli`;
  const result: { exitCode: number; stdout: string } = await (
    await fetch(target, init)
  ).json();
  return result;
}

it("searches thread starts and follow-ups by scope and ranks matches", async () => {
  const server = await setup();
  const call = server.ctx.kernel.call.bind(server.ctx.kernel);
  server.history("Fix the timeline rendering bug", "project", 1);
  server.history("Add tests for the parser", "project", 2);
  server.history("Now update the changelog", "thread", 3);

  const all = await call(promptLibrary.search, {});
  expect(all.prompts.map((row) => row.text)).toEqual([
    "Add tests for the parser",
    "Fix the timeline rendering bug",
  ]);
  expect(all.prompts[0]).toMatchObject({ kind: "recent", projectName: "web" });

  const thread = await call(promptLibrary.search, {
    scope: "thread",
    threadId: "thr_1",
  });
  expect(thread.prompts.map((row) => row.text)).toEqual([
    "Now update the changelog",
  ]);

  const found = await call(promptLibrary.search, {
    query: "tmln",
    scope: "project",
    projectId: server.projectId,
  });
  expect(found.prompts.map((row) => row.text)).toEqual([
    "Fix the timeline rendering bug",
  ]);
  expect(found.prompts[0]?.snippet.highlights.length).toBeGreaterThan(0);
});

it("stars, lists, marks used and unstars prompts", async () => {
  const server = await setup();
  const call = server.ctx.kernel.call.bind(server.ctx.kernel);
  server.history("Review this PR", "project", 1);

  const first = await call(promptLibrary.create, { text: "Review this PR" });
  const again = await call(promptLibrary.create, { text: "Review this PR" });
  expect(again.promptId).toBe(first.promptId);
  await expect(call(promptLibrary.create, { text: "  " })).rejects.toThrow();

  const results = await call(promptLibrary.search, {});
  expect(results.prompts).toEqual([
    expect.objectContaining({ kind: "starred", promptId: first.promptId }),
    expect.objectContaining({ kind: "recent", starredId: first.promptId }),
  ]);
  const searched = await call(promptLibrary.search, { query: "review" });
  expect(searched.prompts.map((row) => row.kind)).toEqual(["starred"]);

  await call(promptLibrary.update, { promptId: first.promptId });
  const [listed] = await call(promptLibrary.list, {});
  expect(listed?.lastUsedAt).not.toBeNull();

  expect(
    await call(promptLibrary.delete, { promptId: first.promptId }),
  ).toEqual({ unstarred: true });
  expect(await call(promptLibrary.list, {})).toEqual([]);
});

it("offers bb prompts search, list, star and unstar", async () => {
  const server = await setup();
  server.history("Explain the build setup", "project", 1);

  const starred = await cli(server, "star", "Write", "release", "notes");
  expect(starred.exitCode).toBe(0);
  const id = starred.stdout.trim();
  expect((await cli(server, "list")).stdout).toContain(
    `${id}  Write release notes`,
  );

  const search = await cli(server, "search", "build", "--json");
  const parsed: { prompts: { text: string }[] } = JSON.parse(search.stdout);
  expect(parsed.prompts.map((row) => row.text)).toEqual([
    "Explain the build setup",
  ]);
  const both = await cli(server, "search", "--project", "p", "--thread", "t");
  expect(both.exitCode).not.toBe(0);

  expect((await cli(server, "unstar", id)).stdout).toBe(`Unstarred ${id}`);
  expect((await cli(server, "unstar", id)).exitCode).not.toBe(0);
});
