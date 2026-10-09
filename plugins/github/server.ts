import {
  environments,
  OpError,
  projects,
  sessions,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import { z } from "zod";
import {
  github,
  pullRequest,
  pullRequests,
  repoName,
  type Item,
  type PullRequest,
  type ThreadLink,
} from "./contract.js";
import { pullRequestDetails } from "./details.js";
import { createIssueMentions } from "./mentions.js";

const SYNC_INTERVAL_MS = 15 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const ISSUE_LIMIT = 100;
const PR_LIMIT = 50;
const GH_HINT =
  "Install the GitHub CLI (https://cli.github.com) and run `gh auth login`, " +
  "then `bb plugin reload github`.";
const ITEM_FIELDS =
  "number,title,state,author,labels,assignees,url,body,updatedAt";
const PR_FIELDS = "number,title,state,isDraft,url,headRefName,baseRefName";

const login = z.object({ login: z.string() }).nullable().catch(null);
const named = z.array(z.object({ name: z.string() })).catch([]);
const logins = z.array(z.object({ login: z.string() })).catch([]);
const ghItem = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  author: login,
  labels: named,
  assignees: logins,
  url: z.string(),
  body: z.string().nullable().catch(""),
  updatedAt: z.string(),
});
const ghPull = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().catch(false),
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
});
const ghComments = z.object({
  comments: z
    .array(z.object({ author: login, body: z.string(), createdAt: z.string() }))
    .catch([]),
});

export function parseGithubRemote(url: string): string | null {
  const match = url
    .trim()
    .match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

export function parseExtraRepos(raw: string) {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    repos: entries.filter((entry) => repoName.safeParse(entry).success),
    ignored: entries.filter((entry) => !repoName.safeParse(entry).success),
  };
}

export function repoOfUrl(url: string): string | null {
  return (
    url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\//)?.[1] ?? null
  );
}

function toItem(repo: string, kind: Item["kind"], raw: unknown): Item {
  const entry = ghItem.parse(raw);
  return {
    repo,
    kind,
    number: entry.number,
    title: entry.title,
    state: entry.state.toLowerCase(),
    author: entry.author?.login ?? "",
    labels: entry.labels.map((label) => label.name),
    assignees: entry.assignees.map((user) => user.login),
    url: entry.url,
    body: entry.body ?? "",
    updatedAt: entry.updatedAt,
  };
}

function toPull(raw: unknown): PullRequest {
  const entry = ghPull.parse(raw);
  const repo = repoOfUrl(entry.url);
  if (repo === null) throw new Error(`Not a GitHub pull request: ${entry.url}`);
  return pullRequest.parse({
    ...entry,
    repo,
    state: entry.state.toLowerCase(),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function githubServer(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    extraRepos: {
      type: "string",
      label: "Extra repositories",
      description:
        'Comma-separated "owner/repo" list to track in addition to repos discovered from BB projects.',
      default: "",
    },
    defaultProject: {
      type: "string",
      label: "Default BB project",
      description:
        "Project id where agent threads spawn for repos that are not attached to a BB project.",
      default: "",
    },
  });

  let authError: string | null = "checking gh…";
  let syncing = false;
  let viewer: { login: string; at: number } | null = null;

  const run = async (
    command: "gh" | "git",
    args: string[],
    where: { hostId?: string; cwd?: string } = {},
  ) => {
    const { stdout } = await bb.runners.call(
      where.hostId ?? bb.server.hostId,
      github.exec,
      { command, args, cwd: where.cwd },
    );
    return stdout;
  };
  const gh = (args: string[], where?: { hostId?: string; cwd?: string }) =>
    run("gh", args, where);
  const json = async (
    args: string[],
    where?: { hostId?: string; cwd?: string },
  ) => z.unknown().parse(JSON.parse(await gh(args, where)));

  const checkAuth = async () => {
    try {
      await gh(["auth", "status", "--hostname", "github.com", "--active"]);
      authError = null;
    } catch (error) {
      authError = /not found/i.test(messageOf(error))
        ? `GitHub CLI not found. ${GH_HINT}`
        : `GitHub CLI is not authenticated. ${GH_HINT}`;
      bb.status.needsConfiguration(authError);
      throw new Error(authError);
    }
  };

  const kvArray = async <T>(key: string, schema: z.ZodType<T>) =>
    z
      .array(schema)
      .catch([])
      .parse((await bb.storage.kv.get(key)) ?? []);
  const cachedItems = () =>
    kvArray(
      "items",
      z.custom<Item>((value) => typeof value === "object"),
    );
  const links = () =>
    kvArray(
      "links",
      z.custom<ThreadLink>((value) => typeof value === "object"),
    );

  const trackedRepos = async () => {
    const { extraRepos } = await settings.get();
    const extra = parseExtraRepos(extraRepos);
    const found = new Map<string, string | null>();
    for (const project of await bb.call(projects.list, {})) {
      const repo =
        project.gitRemoteUrl === null
          ? null
          : parseGithubRemote(project.gitRemoteUrl);
      if (repo !== null && !found.has(repo)) found.set(repo, project.id);
    }
    for (const repo of extra.repos) if (!found.has(repo)) found.set(repo, null);
    return {
      repos: [...found].map(([repo, projectId]) => ({ repo, projectId })),
      ignoredExtraRepos: extra.ignored,
    };
  };

  let inflight: Promise<{ repos: number; items: number }> | null = null;
  const sync = () => {
    inflight ??= syncNow().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  const syncNow = async () => {
    syncing = true;
    bb.changed(github.status);
    try {
      await checkAuth();
      const { repos } = await trackedRepos();
      const items: Item[] = [];
      for (const { repo } of repos) {
        const list = async (kind: Item["kind"], limit: number) => {
          const raw = await json([
            kind === "pr" ? "pr" : "issue",
            "list",
            "-R",
            repo,
            "--state",
            "all",
            "--limit",
            String(limit),
            "--json",
            ITEM_FIELDS,
          ]);
          return z
            .array(z.unknown())
            .parse(raw)
            .map((entry) => toItem(repo, kind, entry));
        };
        items.push(
          ...(await list("issue", ISSUE_LIMIT)),
          ...(await list("pr", PR_LIMIT)),
        );
      }
      await bb.storage.kv.set("items", items);
      await bb.storage.kv.set("lastSyncAt", new Date(bb.now()).toISOString());
      bb.changed(github.issues);
      bb.changed(github.pulls);
      return { repos: repos.length, items: items.length };
    } finally {
      syncing = false;
      bb.changed(github.status);
    }
  };

  const listKind = async (kind: Item["kind"], repo?: string) => ({
    items: (await cachedItems()).filter(
      (entry) =>
        entry.kind === kind && (repo === undefined || entry.repo === repo),
    ),
  });

  const projectFor = async (repo: string) => {
    const { repos } = await trackedRepos();
    const projectId =
      repos.find((entry) => entry.repo === repo)?.projectId ??
      ((await settings.get()).defaultProject || null);
    if (projectId === null) {
      throw new OpError(
        "invalid_input",
        `${repo} is not attached to a BB project. Set the GitHub plugin's Default BB project.`,
      );
    }
    return projectId;
  };

  const spawn = async (kind: Item["kind"], repo: string, number: number) => {
    const cached = (await cachedItems()).find(
      (entry) =>
        entry.kind === kind && entry.repo === repo && entry.number === number,
    );
    const title =
      cached?.title ?? `${kind === "pr" ? "PR" : "issue"} #${number}`;
    const ref = `${repo}#${number}`;
    const prompt =
      kind === "issue"
        ? [
            `Work on GitHub issue ${ref}: ${title}`,
            "",
            "Read the full issue and its comments first:",
            `  gh issue view ${number} -R ${repo} --comments`,
            "",
            cached !== undefined && cached.body.length > 0
              ? `Issue description:\n\n${cached.body}`
              : "(no cached description — read it with the command above)",
            "",
            "Implement a fix or the requested change in this checkout. " +
              `If you open a pull request, include "Fixes #${number}" in its body.`,
          ]
        : [
            `Review GitHub pull request ${ref}: ${title}`,
            "",
            "Read the PR and its diff:",
            `  gh pr view ${number} -R ${repo} --comments`,
            `  gh pr diff ${number} -R ${repo}`,
            "",
            "Review the change for correctness, missing tests, and design issues. " +
              "Summarize your findings with file/line references. Do not push " +
              "changes or post to GitHub unless asked.",
          ];
    const thread = await bb.call(threads.create, {
      origin: "plugin",
      originPluginId: bb.pluginId,
      startedOnBehalfOf: null,
      projectId: await projectFor(repo),
      environment: { type: "project-default" },
      title: `${ref}: ${title}`.slice(0, 120),
      input: [{ type: "text", text: prompt.join("\n"), mentions: [] }],
    });
    const link = {
      kind,
      repo,
      number,
      threadId: thread.id,
      createdAt: new Date(bb.now()).toISOString(),
    };
    await bb.storage.kv.set("links", [...(await links()), link]);
    bb.changed(github.links);
    bb.log.info(`spawned thread ${thread.id} for ${kind} ${ref}`);
    return { threadId: thread.id };
  };

  const checkout = async (environmentId: string) => {
    const environment = await bb.call(environments.get, { environmentId });
    if (environment.path === null) return null;
    return { hostId: environment.hostId, cwd: environment.path };
  };

  bb.implement(github.status, async () => ({
    ready: authError === null,
    error: authError,
    lastSyncAt: z
      .string()
      .nullable()
      .catch(null)
      .parse((await bb.storage.kv.get("lastSyncAt")) ?? null),
    syncing,
  }));
  bb.implement(github.repos, trackedRepos);
  bb.implement(github.issues, ({ repo }) => listKind("issue", repo));
  bb.implement(github.pulls, ({ repo }) => listKind("pr", repo));
  bb.implement(github.sync, sync);
  bb.implement(github.viewer, async () => {
    if (viewer === null || bb.now() - viewer.at > 60 * 60_000) {
      const user = z
        .object({ login: z.string() })
        .parse(await json(["api", "user"]));
      viewer = { login: user.login, at: bb.now() };
    }
    return { login: viewer.login };
  });
  bb.implement(github.assignableUsers, async ({ repo }) => ({
    users: logins
      .parse(await json(["api", `repos/${repo}/assignees?per_page=100`]))
      .map((user) => user.login),
  }));
  bb.implement(github.labels, async ({ repo }) => ({
    labels: named
      .parse(await json(["api", `repos/${repo}/labels?per_page=100`]))
      .map((label) => label.name),
  }));
  bb.implement(github.issue, async ({ repo, number }) => {
    const raw = await json([
      "issue",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      `${ITEM_FIELDS},comments`,
    ]);
    return {
      ...toItem(repo, "issue", raw),
      comments: ghComments.parse(raw).comments.map((entry) => ({
        author: entry.author?.login ?? "",
        body: entry.body,
        createdAt: entry.createdAt,
      })),
    };
  });
  bb.implement(
    github.createIssue,
    async ({ repo, title, body, labels, assignees }) => {
      const args = [
        "issue",
        "create",
        "-R",
        repo,
        "--title",
        title,
        "--body",
        body ?? "",
      ];
      for (const label of labels ?? []) args.push("--label", label);
      for (const user of assignees ?? []) args.push("--assignee", user);
      const url = (await gh(args)).trim().split("\n").at(-1) ?? "";
      const number = Number(url.match(/\/issues\/(\d+)/)?.[1]);
      if (!Number.isInteger(number))
        throw new Error(`gh did not return an issue URL: ${url}`);
      return { number, url };
    },
  );
  bb.implement(
    github.updateIssue,
    async ({ repo, number, state, assignees, labels }) => {
      const id = String(number);
      if (state !== undefined) {
        await gh([
          "issue",
          state === "closed" ? "close" : "reopen",
          id,
          "-R",
          repo,
        ]);
      }
      if (assignees !== undefined || labels !== undefined) {
        const current = await json([
          "issue",
          "view",
          id,
          "-R",
          repo,
          "--json",
          "labels,assignees",
        ]);
        const before = z
          .object({ labels: named, assignees: logins })
          .parse(current);
        const args = ["issue", "edit", id, "-R", repo];
        const diff = (
          flag: string,
          had: string[],
          want: string[] | undefined,
        ) => {
          if (want === undefined) return;
          for (const name of want.filter((entry) => !had.includes(entry)))
            args.push(`--add-${flag}`, name);
          for (const name of had.filter((entry) => !want.includes(entry)))
            args.push(`--remove-${flag}`, name);
        };
        diff(
          "label",
          before.labels.map((label) => label.name),
          labels,
        );
        diff(
          "assignee",
          before.assignees.map((user) => user.login),
          assignees,
        );
        if (args.length > 5) await gh(args);
      }
      return { ok: true as const };
    },
  );
  bb.implement(github.createIssueComment, async ({ repo, number, body }) => {
    await gh(["issue", "comment", String(number), "-R", repo, "--body", body]);
    return { ok: true as const };
  });
  bb.implement(github.startWork, ({ repo, number }) =>
    spawn("issue", repo, number),
  );
  bb.implement(github.links, links);

  bb.implement(pullRequests.get, async ({ environmentId }) => {
    const where = await checkout(environmentId);
    if (where === null) return null;
    try {
      return toPull(await json(["pr", "view", "--json", PR_FIELDS], where));
    } catch (error) {
      if (/no (open )?pull requests? found/i.test(messageOf(error)))
        return null;
      throw error;
    }
  });
  bb.implement(pullRequests.list, async ({ repo, state }) => {
    const raw = await json([
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      state ?? "open",
      "--limit",
      String(PR_LIMIT),
      "--json",
      PR_FIELDS,
    ]);
    return z.array(z.unknown()).parse(raw).map(toPull);
  });
  bb.implement(
    pullRequests.create,
    async ({ environmentId, title, body, base, draft }) => {
      const where = await checkout(environmentId);
      if (where === null) {
        throw new OpError("invalid_input", "This environment has no checkout");
      }
      const args = ["pr", "create", "--title", title, "--body", body ?? ""];
      if (base !== undefined) args.push("--base", base);
      if (draft === true) args.push("--draft");
      const url = (await gh(args, where)).trim().split("\n").at(-1) ?? "";
      return toPull(
        await json(["pr", "view", url, "--json", PR_FIELDS], where),
      );
    },
  );
  bb.implement(pullRequests.details, ({ repo, number }) =>
    pullRequestDetails((args) => json(args), repo, number),
  );
  bb.implement(pullRequests.createComment, async ({ repo, number, body }) => {
    await gh(["pr", "comment", String(number), "-R", repo, "--body", body]);
    return { ok: true as const };
  });
  bb.implement(pullRequests.createReview, ({ repo, number }) =>
    spawn("pr", repo, number),
  );
  bb.implement(pullRequests.forThread, async ({ threadId }) => {
    const thread = await bb.call(threads.get, { threadId }).catch(() => null);
    const environmentId = thread?.environmentId ?? null;
    if (environmentId !== null) {
      const pull = await bb
        .call(pullRequests.get, { environmentId })
        .catch(() => null);
      if (pull !== null) {
        return {
          pull: { repo: pull.repo, number: pull.number, environmentId },
        };
      }
    }
    const link = (await links()).find(
      (entry) => entry.kind === "pr" && entry.threadId === threadId,
    );
    return {
      pull:
        link === undefined
          ? null
          : { repo: link.repo, number: link.number, environmentId },
    };
  });

  const liveItem = async (kind: Item["kind"], repo: string, number: number) =>
    toItem(
      repo,
      kind,
      await json([
        kind,
        "view",
        String(number),
        "-R",
        repo,
        "--json",
        ITEM_FIELDS,
      ]),
    );
  for (const provider of createIssueMentions(cachedItems, liveItem)) {
    bb.add(sessions.mention, provider);
  }

  bb.background.service("sync", {
    async start(signal) {
      let retry = RETRY_BASE_MS;
      while (!signal.aborted) {
        let wait = SYNC_INTERVAL_MS;
        try {
          await sync();
          retry = RETRY_BASE_MS;
        } catch (error) {
          bb.log.warn(`GitHub sync failed: ${messageOf(error)}`);
          wait = retry;
          retry = Math.min(retry * 2, RETRY_MAX_MS);
        }
        await new Promise<void>((done) => {
          const timer = setTimeout(done, wait);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            done();
          });
        });
      }
    },
  });
}
