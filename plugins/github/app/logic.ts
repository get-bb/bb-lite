import type { Item, PullRequest, ThreadLink } from "../contract.js";

export type Route =
  | { view: "issues" | "pulls" | "new" }
  | { view: "issue" | "pull"; repo: string; number: number };

export function parseSubPath(subPath: string): Route {
  const [head, owner, name, raw] = subPath.split("/").filter(Boolean);
  const view = head === "pulls" ? "pull" : head === "issues" ? "issue" : null;
  const number = Number(raw);
  if (view !== null && name !== undefined && Number.isInteger(number)) {
    return { view, repo: `${owner}/${name}`, number };
  }
  if (head === "pulls" || head === "new") return { view: head };
  return { view: "issues" };
}

export function routeToSubPath(route: Route): string {
  if (route.view === "issue" || route.view === "pull") {
    return `${route.view}s/${route.repo}/${route.number}`;
  }
  return route.view;
}

export interface ParsedQuery {
  states: string[];
  assignees: string[];
  authors: string[];
  labels: string[];
  repos: string[];
  noAssignee: boolean;
  noLabel: boolean;
  text: string[];
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = {
    states: [],
    assignees: [],
    authors: [],
    labels: [],
    repos: [],
    noAssignee: false,
    noLabel: false,
    text: [],
  };
  for (const token of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const index = token.indexOf(":");
    const key = index > 0 ? token.slice(0, index).toLowerCase() : "";
    const value = token
      .slice(index + 1)
      .replace(/"/g, "")
      .toLowerCase();
    if (index > 0 && value.length === 0) continue;
    if (key === "is" || key === "state") parsed.states.push(value);
    else if (key === "assignee") parsed.assignees.push(value);
    else if (key === "author") parsed.authors.push(value);
    else if (key === "label") parsed.labels.push(value);
    else if (key === "repo") parsed.repos.push(value);
    else if (key === "no") {
      if (value === "assignee") parsed.noAssignee = true;
      if (value === "label") parsed.noLabel = true;
    } else parsed.text.push(token.replace(/"/g, "").toLowerCase());
  }
  return parsed;
}

function logins(wanted: string[], viewer: string | null): string[] {
  return wanted.map((login) =>
    login === "@me" ? (viewer?.toLowerCase() ?? "\u0000") : login,
  );
}

export function matchesQuery(
  item: Item,
  query: ParsedQuery,
  viewer: string | null,
): boolean {
  const lower = (values: string[]) => values.map((v) => v.toLowerCase());
  const assignees = lower(item.assignees);
  const labels = lower(item.labels);
  const haystack = `${item.title} #${item.number} ${item.repo}`.toLowerCase();
  return (
    (query.states.length === 0 ||
      query.states.includes(item.state.toLowerCase())) &&
    (query.assignees.length === 0 ||
      logins(query.assignees, viewer).some((l) => assignees.includes(l))) &&
    (query.authors.length === 0 ||
      logins(query.authors, viewer).includes(item.author.toLowerCase())) &&
    (query.labels.length === 0 ||
      query.labels.some((label) => labels.includes(label))) &&
    (query.repos.length === 0 ||
      query.repos.includes(item.repo.toLowerCase())) &&
    !(query.noAssignee && assignees.length > 0) &&
    !(query.noLabel && labels.length > 0) &&
    query.text.every((term) => haystack.includes(term))
  );
}

export function filterItems(
  items: Item[],
  query: string,
  viewer: string | null,
): Item[] {
  const parsed = parseQuery(query);
  return items
    .filter((item) => matchesQuery(item, parsed, viewer))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function linksFor(
  links: ThreadLink[],
  item: { repo: string; number: number },
): ThreadLink[] {
  return links.filter(
    (link) => link.repo === item.repo && link.number === item.number,
  );
}

export function toggle(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  const units: [number, string][] = [
    [86400 * 365, "y"],
    [86400 * 30, "mo"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return "just now";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATE_LABEL: Record<string, string> = {
  merged: "Merged",
  closed: "Closed",
};

export function pullStateLabel(
  pull: Pick<PullRequest, "state" | "isDraft">,
): string {
  if (pull.state === "open") return pull.isDraft ? "Draft" : "Open";
  return STATE_LABEL[pull.state] ?? pull.state;
}
