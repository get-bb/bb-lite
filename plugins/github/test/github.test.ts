import { expect, it, vi } from "vitest";
import {
  insertEnvironment,
  insertThread,
} from "../../../apps/server/test/helpers.js";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";

type Exec = {
  command: "gh" | "git";
  args: string[];
  cwd?: string;
};

const issue = (number: number, title: string) => ({
  number,
  title,
  state: "OPEN",
  author: { login: "octocat" },
  labels: [{ name: "bug" }],
  assignees: [],
  url: `https://github.com/acme/app/issues/${number}`,
  body: `Body of ${title}`,
  updatedAt: "2026-10-01T00:00:00Z",
});
const pull = {
  number: 7,
  title: "Add widgets",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/acme/app/pull/7",
  headRefName: "widgets",
  baseRefName: "main",
};

async function githubServer(options: { signedIn?: boolean } = {}) {
  const server = await createThreadServer();
  const calls: Exec[] = [];
  const answer = (input: Exec): unknown => {
    const [verb, sub] = input.args;
    if (verb === "auth") {
      if (options.signedIn === false) throw new Error("not logged in");
      return "";
    }
    if (verb === "issue" && sub === "list") {
      return input.args.includes("acme/app")
        ? [issue(1, "Crash on start")]
        : [];
    }
    if (verb === "pr" && sub === "list") {
      return input.args.includes("acme/app")
        ? [{ ...issue(7, "Add widgets"), url: pull.url }]
        : [];
    }
    if (verb === "pr" && sub === "view") {
      if (input.cwd === "/checkouts/none")
        throw new Error('no pull requests found for branch "x"');
      const conflicted = input.cwd === "/checkouts/conflicted";
      return { ...pull, mergeable: conflicted ? "CONFLICTING" : "MERGEABLE" };
    }
    if (verb === "pr" && (sub === "ready" || sub === "merge")) return "";
    throw new Error(`unexpected gh ${input.args.join(" ")}`);
  };
  const previous = server.runner.script.callOp;
  server.runner.script.callOp = async (op) => {
    const { name } = op;
    const input = op.input as Exec;
    if (name !== "github.exec") return previous?.(op);
    calls.push(input);
    const out = answer(input);
    return { stdout: typeof out === "string" ? out : JSON.stringify(out) };
  };
  server.runner.script.listModels = async () => ({
    models: [
      {
        id: "gpt-test",
        model: "gpt-test",
        displayName: "gpt-test",
        description: "gpt-test",
        supportedReasoningEfforts: [],
        isDefault: true,
        defaultReasoningEffort: "medium" as const,
      },
    ],
    selectedOnlyModels: [],
  });
  server.ctx.db.run(
    "UPDATE projects SET git_remote_url = ? WHERE id = 'proj_1'",
    "git@github.com:acme/app.git",
  );
  const op = async (name: string, input: unknown = {}) => {
    const { status, body } = await server.http<{ result?: unknown }>(
      "POST",
      `/ops/${name}`,
      input,
    );
    if (status >= 400) throw new Error(JSON.stringify(body));
    return body.result;
  };
  const cli = async (...argv: string[]) =>
    (
      await server.http<{ exitCode: number; stdout: string }>(
        "POST",
        "/plugins/github/cli",
        { argv },
      )
    ).body;
  return { ...server, calls, op, cli };
}

it("syncs tracked repositories and lists the cache from the CLI", async () => {
  const { cli, op, calls } = await githubServer();
  expect(await op("github.sync")).toEqual({ repos: 1, items: 2 });
  expect(calls.every((call) => call.command === "gh")).toBe(true);

  expect((await cli("repos")).stdout).toBe("acme/app\t(proj_1)");
  expect((await cli("issues")).stdout).toBe(
    "acme/app#1\t[open]\tCrash on start",
  );
  const prs = JSON.parse((await cli("prs", "acme/app", "--json")).stdout);
  expect(prs.items).toEqual([
    expect.objectContaining({ kind: "pr", number: 7, author: "octocat" }),
  ]);
  expect((await cli("prs", "acme/other")).stdout).toBe(
    "Nothing cached. Run `bb github sync` first.",
  );
});

it("reports that gh needs signing in", async () => {
  const { op, http } = await githubServer({ signedIn: false });
  await expect(op("github.sync")).rejects.toThrow(/gh auth login/);
  expect(await http("POST", "/ops/github.viewer", {})).toMatchObject({
    status: 503,
    body: { code: "github_unavailable" },
  });
  await vi.waitFor(async () =>
    expect(await op("github.status")).toMatchObject({
      ready: false,
      error: expect.stringContaining("not authenticated"),
    }),
  );
});

it("finds the pull request of an environment on its machine", async () => {
  const server = await githubServer();
  const { op, calls, hostId } = server;
  const testServer = server as unknown as Parameters<
    typeof insertEnvironment
  >[0];
  insertEnvironment(testServer, {
    id: "env_pr",
    projectId: "proj_1",
    hostId,
    path: "/checkouts/widgets",
  });
  insertEnvironment(testServer, {
    id: "env_none",
    projectId: "proj_1",
    hostId,
    path: "/checkouts/none",
  });
  expect(await op("pullRequests.get", { environmentId: "env_pr" })).toEqual({
    ...pull,
    repo: "acme/app",
    state: "open",
  });
  expect(calls.at(-1)).toMatchObject({ cwd: "/checkouts/widgets" });
  insertThread(testServer, "thr_pr", "proj_1", { environmentId: "env_pr" });
  expect(await op("pullRequests.forThread", { threadId: "thr_pr" })).toEqual({
    pull: { repo: "acme/app", number: 7, environmentId: "env_pr" },
  });
  expect(await op("pullRequests.get", { environmentId: "env_none" })).toBe(
    null,
  );
  const args = () => calls.map((call) => call.args.join(" "));
  await op("pullRequests.update", { environmentId: "env_pr", draft: true });
  expect(args()).toContain("pr ready --undo");
  await op("pullRequests.update", { environmentId: "env_pr", draft: false });
  expect(args()).toContain("pr ready");
  const merged = await op("pullRequests.merge", { environmentId: "env_pr" });
  expect(merged).toMatchObject({ number: 7 });
  expect(args()).toContain("pr merge --squash");
  insertEnvironment(testServer, {
    id: "env_conflicted",
    projectId: "proj_1",
    hostId,
    path: "/checkouts/conflicted",
  });
  const refused = server.http("POST", "/ops/pullRequests.merge", {
    environmentId: "env_conflicted",
    method: "rebase",
  });
  expect(await refused).toMatchObject({
    status: 409,
    body: { code: "pull_request_not_mergeable" },
  });
  const missing = server.http("POST", "/ops/pullRequests.merge", {
    environmentId: "env_none",
  });
  expect(await missing).toMatchObject({
    status: 404,
    body: { code: "pull_request_not_found" },
  });
});

it("starts an agent thread on an issue and links it", async () => {
  const { op, submitted } = await githubServer();
  await op("github.sync");
  const { threadId } = (await op("github.startWork", {
    repo: "acme/app",
    number: 1,
  })) as { threadId: string };
  expect(await op("github.links")).toEqual([
    expect.objectContaining({ kind: "issue", number: 1, threadId }),
  ]);
  await vi.waitFor(() =>
    expect(JSON.stringify(submitted.at(-1))).toContain(
      "Work on GitHub issue acme/app#1: Crash on start",
    ),
  );
});
