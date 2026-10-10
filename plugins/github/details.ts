import { z } from "zod";
import type { PullRequestDetails } from "./contract.js";

type Json = (args: string[]) => Promise<unknown>;

const text = z
  .string()
  .nullable()
  .catch("")
  .transform((value) => value ?? "");
const count = z.number().catch(0);
const author = z
  .object({ login: z.string() })
  .nullable()
  .catch(null)
  .transform((value) => value?.login ?? "");
const comment = z.object({ author, body: text, createdAt: text });
const view = z.object({
  number: z.number(),
  title: z.string(),
  body: text,
  state: z.string(),
  isDraft: z.boolean().catch(false),
  author,
  createdAt: text,
  updatedAt: text,
  url: z.string(),
  baseRefName: text,
  headRefName: text,
  additions: count,
  deletions: count,
  changedFiles: count,
  reviewDecision: text,
  mergeStateStatus: text,
  labels: z.array(z.object({ name: z.string() })).catch([]),
  assignees: z.array(z.object({ login: z.string() })).catch([]),
  reviewRequests: z
    .array(
      z.object({ login: z.string().optional(), name: z.string().optional() }),
    )
    .catch([]),
  statusCheckRollup: z
    .array(
      z.object({
        name: z.string().optional(),
        context: z.string().optional(),
        status: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        state: z.string().optional(),
        detailsUrl: z.string().nullable().optional(),
        targetUrl: z.string().nullable().optional(),
      }),
    )
    .catch([]),
  comments: z.array(comment).catch([]),
  reviews: z
    .array(z.object({ author, state: text, body: text, submittedAt: text }))
    .catch([]),
});
const pages = <T extends z.ZodType>(entry: T) =>
  z.array(z.array(entry)).transform((list) => list.flat());
const reviewComment = z.object({
  id: z.number(),
  in_reply_to_id: z.number().optional(),
  path: text,
  line: z.number().nullable().catch(null),
  original_line: z.number().nullable().catch(null),
  diff_hunk: text,
  user: z.object({ login: z.string() }).nullable().catch(null),
  body: text,
  created_at: text,
});
const file = z.object({
  filename: z.string(),
  status: text,
  additions: count,
  deletions: count,
  patch: z.string().optional(),
});

const FIELDS =
  "number,title,body,state,isDraft,author,createdAt,updatedAt,labels," +
  "assignees,url,baseRefName,headRefName,additions,deletions," +
  "changedFiles,reviewDecision,mergeStateStatus,statusCheckRollup," +
  "comments,reviews,reviewRequests";

export function checkStatus(check: {
  status?: string;
  conclusion?: string | null;
  state?: string;
}): "success" | "failure" | "pending" | "neutral" {
  const value = (check.conclusion ?? check.state ?? "").toUpperCase();
  if (value === "SUCCESS") return "success";
  if (["NEUTRAL", "SKIPPED", "STALE"].includes(value)) return "neutral";
  if (
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
      value,
    )
  ) {
    return "failure";
  }
  return "pending";
}

export async function pullRequestDetails(
  json: Json,
  repo: string,
  number: number,
): Promise<PullRequestDetails> {
  const api = (path: string) =>
    json([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/pulls/${number}/${path}?per_page=100`,
    ]);
  const [rawView, rawComments, rawFiles] = await Promise.all([
    json(["pr", "view", String(number), "-R", repo, "--json", FIELDS]),
    api("comments"),
    api("files"),
  ]);
  const pull = view.parse(rawView);
  const threads = new Map<
    number,
    PullRequestDetails["reviewThreads"][number]
  >();
  for (const entry of pages(reviewComment).parse(rawComments)) {
    const root = entry.in_reply_to_id ?? entry.id;
    const thread = threads.get(root) ?? {
      path: entry.path,
      line: entry.line ?? entry.original_line,
      diffHunk: entry.diff_hunk,
      comments: [],
    };
    thread.comments.push({
      author: entry.user?.login ?? "",
      body: entry.body,
      createdAt: entry.created_at,
    });
    threads.set(root, thread);
  }
  return {
    repo,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toLowerCase(),
    isDraft: pull.isDraft,
    author: pull.author,
    url: pull.url,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    baseRefName: pull.baseRefName,
    headRefName: pull.headRefName,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changedFiles,
    labels: pull.labels.map((label) => label.name),
    assignees: pull.assignees.map((user) => user.login),
    reviewDecision: pull.reviewDecision,
    mergeStateStatus: pull.mergeStateStatus,
    reviewRequests: pull.reviewRequests.map(
      (request) => request.login ?? request.name ?? "",
    ),
    checks: pull.statusCheckRollup.map((check) => ({
      name: check.name ?? check.context ?? "",
      status: checkStatus(check),
      url: check.detailsUrl ?? check.targetUrl ?? "",
    })),
    comments: pull.comments,
    reviews: pull.reviews.map((review) => ({
      author: review.author,
      state: review.state,
      body: review.body,
      createdAt: review.submittedAt,
    })),
    reviewThreads: [...threads.values()],
    files: pages(file)
      .parse(rawFiles)
      .map((entry) => ({
        path: entry.filename,
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        patch: entry.patch ?? null,
      })),
  };
}
