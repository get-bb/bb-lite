import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const repoName = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const number = z.number().int().positive();
const text = z.string().refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});
const itemRef = z.object({ repo: repoName, number }).strict();
const ok = z.object({ ok: z.literal(true) });
const kind = z.enum(["issue", "pr"]);

export const item = z.object({
  repo: repoName,
  number,
  kind,
  title: z.string(),
  state: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  url: z.string(),
  body: z.string(),
  updatedAt: z.string(),
});
export type Item = z.infer<typeof item>;

const comment = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const threadLink = z.object({
  kind,
  repo: repoName,
  number,
  threadId: z.string(),
  createdAt: z.string(),
});
export type ThreadLink = z.infer<typeof threadLink>;

const repo = z.object({ repo: repoName, projectId: z.string().nullable() });
const syncResult = z.object({
  repos: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
});

export const pullRequest = z.object({
  repo: repoName,
  number,
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
});
export type PullRequest = z.infer<typeof pullRequest>;

export const pullRequestDetails = pullRequest.extend({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  additions: z.number().nonnegative(),
  deletions: z.number().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  reviewDecision: z.string(),
  mergeStateStatus: z.string(),
  reviewRequests: z.array(z.string()),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["success", "failure", "pending", "neutral"]),
      url: z.string(),
    }),
  ),
  comments: z.array(comment),
  reviews: z.array(comment.extend({ state: z.string() })),
  reviewThreads: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().nonnegative().nullable(),
      diffHunk: z.string(),
      comments: z.array(comment),
    }),
  ),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.number().nonnegative(),
      deletions: z.number().nonnegative(),
      patch: z.string().nullable(),
    }),
  ),
});
export type PullRequestDetails = z.infer<typeof pullRequestDetails>;

const printItems = ({ items }: { items: Item[] }) =>
  items.length === 0
    ? "Nothing cached. Run `bb github sync` first."
    : items
        .map(
          (entry) =>
            `${entry.repo}#${entry.number}\t[${entry.state}]\t${entry.title}`,
        )
        .join("\n");

const repoFilter = z
  .object({
    repo: repoName.optional().describe("Only this owner/repo"),
  })
  .strict();

export const github = contract("github", {
  status: op({
    input: z.object({}),
    output: z.object({
      ready: z.boolean(),
      error: z.string().nullable(),
      lastSyncAt: z.string().nullable(),
      syncing: z.boolean(),
    }),
  }),
  repos: op({
    input: z.object({}),
    output: z.object({
      repos: z.array(repo),
      ignoredExtraRepos: z.array(z.string()),
    }),
    doors: {
      cli: {
        path: "github repos",
        summary: "List tracked repositories",
        print: ({ repos }) =>
          repos.length === 0
            ? "No GitHub repositories tracked."
            : repos
                .map(({ repo, projectId }) =>
                  projectId === null ? repo : `${repo}\t(${projectId})`,
                )
                .join("\n"),
      },
    },
  }),
  issues: op({
    input: repoFilter,
    output: z.object({ items: z.array(item) }),
    doors: {
      cli: {
        path: "github issues",
        print: printItems,
        summary: "List cached open and recent issues",
        positionals: ["repo"],
      },
    },
  }),
  pulls: op({
    input: repoFilter,
    output: z.object({ items: z.array(item) }),
    doors: {
      cli: {
        path: "github prs",
        print: printItems,
        summary: "List cached open and recent pull requests",
        positionals: ["repo"],
      },
    },
  }),
  sync: op({
    input: z.object({}),
    output: syncResult,
    kind: "write",
    audit: false,
    doors: {
      cli: {
        path: "github sync",
        summary: "Refresh the cache from GitHub now",
        print: ({ repos, items }) =>
          `Synced ${items} item(s) across ${repos} repo(s).`,
      },
    },
  }),
  viewer: op({ input: z.object({}), output: z.object({ login: z.string() }) }),
  assignableUsers: op({
    input: z.object({ repo: repoName }).strict(),
    output: z.object({ users: z.array(z.string()) }),
  }),
  labels: op({
    input: z.object({ repo: repoName }).strict(),
    output: z.object({ labels: z.array(z.string()) }),
  }),
  issue: op({
    input: itemRef,
    output: item.extend({ comments: z.array(comment) }),
  }),
  createIssue: op({
    input: z
      .object({
        repo: repoName,
        title: text,
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
      })
      .strict(),
    output: z.object({ number, url: z.string() }),
    kind: "write",
  }),
  updateIssue: op({
    input: itemRef
      .extend({
        state: z.enum(["open", "closed"]).optional(),
        assignees: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
      })
      .strict(),
    output: ok,
    kind: "write",
  }),
  createIssueComment: op({
    input: itemRef.extend({ body: text }).strict(),
    output: ok,
    kind: "write",
  }),
  startWork: op({
    input: itemRef,
    output: z.object({ threadId: z.string() }),
    kind: "write",
  }),
  links: op({ input: z.object({}), output: z.array(threadLink) }),
  exec: op({
    input: z
      .object({
        command: z.enum(["gh", "git"]),
        args: z.array(z.string()),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: z.object({ stdout: z.string() }),
    audit: false,
    internal: true,
  }),
});

export const pullRequests = contract("pullRequests", {
  get: op({
    input: z.object({ environmentId: z.string().min(1) }).strict(),
    output: pullRequest.nullable(),
  }),
  list: op({
    input: z
      .object({
        repo: repoName,
        state: z.enum(["open", "closed", "merged", "all"]).optional(),
      })
      .strict(),
    output: z.array(pullRequest),
  }),
  create: op({
    input: z
      .object({
        environmentId: z.string().min(1),
        title: text,
        body: z.string().optional(),
        base: z.string().optional(),
        draft: z.boolean().optional(),
      })
      .strict(),
    output: pullRequest,
    kind: "write",
  }),
  details: op({ input: itemRef, output: pullRequestDetails }),
  forThread: op({
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      pull: itemRef.extend({ environmentId: z.string().nullable() }).nullable(),
    }),
  }),
  createComment: op({
    input: itemRef.extend({ body: text }).strict(),
    output: ok,
    kind: "write",
  }),
  createReview: op({
    input: itemRef,
    output: z.object({ threadId: z.string() }),
    kind: "write",
  }),
});
