import { randomUUID } from "node:crypto";
import {
  cliCommand,
  defineCli,
  fail,
  PluginCliError,
  projects,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import type { PromptHistoryEntry } from "@bb/domain";
import { z } from "zod";
import {
  promptLibrary,
  type PromptRow,
  type SearchInput,
  type StarredPrompt,
} from "./contract.js";
import {
  buildSnippet,
  createSearchIndex,
  matchPositions,
  queryTerms,
} from "./ranking.js";

const STARRED_RESULT_LIMIT = 20;
const RECENT_RESULT_LIMIT = 30;
const HISTORY_LIMIT = 1000;

const MIGRATIONS = [
  `CREATE TABLE starred_prompts (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
];

const recordSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    created_at: z.number(),
    last_used_at: z.number().nullable(),
  })
  .transform((row): StarredPrompt => ({
    promptId: row.id,
    text: row.text,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));

interface Recent {
  promptId: string;
  text: string;
  createdAt: number;
  projectId: string;
  threadId: string | null;
  startsThread: boolean;
}

type Item =
  | { kind: "starred"; prompt: StarredPrompt }
  | { kind: "recent"; recent: Recent };

function promptText(entry: PromptHistoryEntry): string {
  return entry.input
    .flatMap((chunk) =>
      chunk.type === "text" && chunk.text.trim().length > 0 ? [chunk.text] : [],
    )
    .join("\n\n");
}

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

export default function promptLibraryServer(bb: PluginServerApi): void {
  const db = bb.storage.database(MIGRATIONS);
  const columns = "id, text, created_at, last_used_at";
  const list = () =>
    db
      .prepare(
        `SELECT ${columns} FROM starred_prompts
          ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC`,
      )
      .all()
      .map((row) => recordSchema.parse(row));
  const byText = (text: string) => {
    const row = db
      .prepare(`SELECT ${columns} FROM starred_prompts WHERE text = ?`)
      .get(text);
    return row === undefined ? null : recordSchema.parse(row);
  };

  function star(text: string): StarredPrompt {
    if (text.trim().length === 0) {
      fail("invalid", "A starred prompt needs some text.");
    }
    const existing = byText(text);
    if (existing !== null) return existing;
    const prompt = {
      promptId: `prompt_${randomUUID()}`,
      text,
      createdAt: bb.now(),
      lastUsedAt: null,
    };
    db.prepare(
      `INSERT INTO starred_prompts (id, text, created_at) VALUES (?, ?, ?)`,
    ).run(prompt.promptId, text, prompt.createdAt);
    bb.changed(promptLibrary.list);
    bb.changed(promptLibrary.search);
    return prompt;
  }

  function unstar(promptId: string): boolean {
    const removed =
      db.prepare(`DELETE FROM starred_prompts WHERE id = ?`).run(promptId)
        .changes > 0;
    if (removed) {
      bb.changed(promptLibrary.list);
      bb.changed(promptLibrary.search);
    }
    return removed;
  }

  async function projectHistory(projectId: string): Promise<Recent[]> {
    const entries = await bb.call(projects.promptHistory, {
      projectId,
      limit: HISTORY_LIMIT,
    });
    return entries.map((entry) => ({
      promptId: entry.id,
      text: promptText(entry),
      createdAt: entry.createdAt,
      projectId,
      threadId: null,
      startsThread: true,
    }));
  }

  async function history(input: SearchInput): Promise<Recent[]> {
    if (input.scope === "thread") {
      if (input.threadId === null) return [];
      const { threadId } = input;
      const thread = await bb.call(threads.get, { threadId });
      const entries = await bb.call(threads.promptHistory, {
        threadId,
        limit: HISTORY_LIMIT,
      });
      return entries.map((entry) => ({
        promptId: entry.id,
        text: promptText(entry),
        createdAt: entry.createdAt,
        projectId: thread.projectId,
        threadId,
        startsThread: false,
      }));
    }
    if (input.scope === "project") {
      return input.projectId === null ? [] : projectHistory(input.projectId);
    }
    const recent: Recent[] = [];
    let cursor: string | undefined;
    do {
      const page = await bb.call(threads.recentPrompts, { cursor, limit: 200 });
      for (const entry of page.entries) {
        if (entry.scope !== "project") continue;
        recent.push({
          promptId: entry.id,
          text: entry.text,
          createdAt: entry.sentAt,
          projectId: entry.projectId,
          threadId: null,
          startsThread: true,
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && recent.length < HISTORY_LIMIT);
    return recent;
  }

  function ordered(
    input: SearchInput,
    starred: readonly StarredPrompt[],
    recent: readonly Recent[],
  ): Item[] {
    const searching = queryTerms(input.query).length > 0;
    const starredItems = starred.map((prompt): Item => ({
      kind: "starred",
      prompt,
    }));
    const recentItems = recent.map((entry): Item => ({
      kind: "recent",
      recent: entry,
    }));
    let items = [...starredItems, ...recentItems];
    if (searching) {
      const index = createSearchIndex<Item>();
      for (const item of [...recentItems].reverse()) {
        if (item.kind !== "recent") continue;
        const { text, createdAt } = item.recent;
        index.add({ item, text, time: createdAt });
      }
      const extra = starred.map((prompt) => ({
        item: { kind: "starred" as const, prompt },
        text: prompt.text,
        time: prompt.lastUsedAt ?? prompt.createdAt,
      }));
      const favorStarts = input.composer === "new-thread";
      items = index
        .search(
          input.query,
          extra,
          bb.now(),
          (item) =>
            item.kind === "starred" || item.recent.startsThread === favorStarts,
        )
        .map((match) => match.item);
    }
    const seen = new Set(searching ? starred.map(({ text }) => text) : []);
    let starredCount = 0;
    let recentCount = 0;
    return items.filter((item) => {
      if (item.kind === "starred") {
        if (starredCount === STARRED_RESULT_LIMIT) return false;
        starredCount += 1;
        return true;
      }
      const { text } = item.recent;
      if (recentCount === RECENT_RESULT_LIMIT) return false;
      if (text.trim().length === 0 || seen.has(text)) return false;
      seen.add(text);
      recentCount += 1;
      return true;
    });
  }

  async function search(input: SearchInput) {
    const starred = list();
    const starredIds = new Map(starred.map((p) => [p.text, p.promptId]));
    const items = ordered(input, starred, await history(input));
    const needNames = items.some((item) => item.kind === "recent");
    const names = new Map(
      needNames
        ? (await bb.call(projects.list, { includePersonal: true })).map(
            (project) => [project.id, project.name],
          )
        : [],
    );
    const snippet = (text: string) =>
      buildSnippet(text, matchPositions(text, input.query));
    const prompts = items.map((item): PromptRow => {
      if (item.kind === "starred") {
        const { prompt } = item;
        return { kind: "starred", ...prompt, snippet: snippet(prompt.text) };
      }
      const { startsThread: _, ...recent } = item.recent;
      return {
        kind: "recent",
        ...recent,
        snippet: snippet(recent.text),
        projectName: names.get(recent.projectId) ?? null,
        starredId: starredIds.get(recent.text) ?? null,
      };
    });
    return { prompts };
  }

  bb.implement(promptLibrary.search, search);
  bb.implement(promptLibrary.list, () => list());
  bb.implement(promptLibrary.create, ({ text }) => star(text));
  bb.implement(promptLibrary.delete, ({ promptId }) => ({
    unstarred: unstar(promptId),
  }));
  bb.implement(promptLibrary.update, ({ promptId }) => {
    db.prepare(`UPDATE starred_prompts SET last_used_at = ? WHERE id = ?`).run(
      bb.now(),
      promptId,
    );
    bb.changed(promptLibrary.list);
    return null;
  });

  const searchCommand = cliCommand({
    summary: "Search starred and previous prompts",
    positionals: [
      {
        name: "query",
        description:
          "Words that must each match a prompt word exactly, as its start, with one typo, inside it, or as an abbreviation; omit to list the most recent",
        variadic: true,
      },
    ],
    options: {
      project: { type: "string", description: "Search this project's prompts" },
      thread: { type: "string", description: "Search this thread's prompts" },
      composer: {
        type: "enum",
        values: ["new-thread", "follow-up"],
        default: "follow-up",
        description:
          "Rank like this composer: new-thread favors prompts that started threads, follow-up favors follow-ups",
      },
      json: JSON_OPTION,
    },
    async run({ options, positionals }) {
      if (options.project !== undefined && options.thread !== undefined) {
        throw new PluginCliError("Pass at most one of --project and --thread", {
          code: "invalid_options",
        });
      }
      const result = await search({
        query: positionals.query.join(" "),
        scope:
          options.thread !== undefined
            ? "thread"
            : options.project !== undefined
              ? "project"
              : "global",
        projectId: options.project ?? null,
        threadId: options.thread ?? null,
        composer: options.composer,
      });
      if (options.json) return { exitCode: 0, stdout: JSON.stringify(result) };
      const lines = result.prompts.map((row) =>
        row.kind === "starred"
          ? `★ ${row.promptId}  ${row.snippet.text}`
          : `  ${new Date(row.createdAt).toISOString()}  ${row.snippet.text}`,
      );
      const stdout = lines.length > 0 ? lines.join("\n") : "No prompts found";
      return { exitCode: 0, stdout };
    },
  });

  const listCommand = cliCommand({
    summary: "List starred prompts, most recently used first",
    options: { json: JSON_OPTION },
    run({ options }) {
      const prompts = list();
      if (options.json) {
        return { exitCode: 0, stdout: JSON.stringify(prompts) };
      }
      const lines = prompts.map(
        (prompt) => `${prompt.promptId}  ${buildSnippet(prompt.text, []).text}`,
      );
      const stdout = lines.length > 0 ? lines.join("\n") : "No starred prompts";
      return { exitCode: 0, stdout };
    },
  });

  const starCommand = cliCommand({
    summary: "Star a prompt",
    positionals: [
      {
        name: "text",
        description: "The prompt text",
        required: true,
        variadic: true,
      },
    ],
    options: { json: JSON_OPTION },
    run({ options, positionals }) {
      const starred = star(positionals.text.join(" "));
      const stdout = options.json
        ? JSON.stringify({ id: starred.promptId, text: starred.text })
        : starred.promptId;
      return { exitCode: 0, stdout };
    },
  });

  const unstarCommand = cliCommand({
    summary: "Unstar a prompt",
    positionals: [
      {
        name: "id",
        description: "Starred prompt id, as `bb prompts list` prints it",
        required: true,
      },
    ],
    options: { json: JSON_OPTION },
    run({ options, positionals }) {
      if (!unstar(positionals.id)) {
        throw new PluginCliError(`Unknown starred prompt: ${positionals.id}`, {
          code: "unknown_prompt",
          hint: "Run `bb prompts list` for starred prompt ids.",
        });
      }
      const stdout = options.json
        ? JSON.stringify({ id: positionals.id, unstarred: true })
        : `Unstarred ${positionals.id}`;
      return { exitCode: 0, stdout };
    },
  });

  bb.cli.register(
    defineCli({
      name: "prompts",
      summary: "Search previous prompts and manage starred prompts",
      commands: {
        search: searchCommand,
        list: listCommand,
        star: starCommand,
        unstar: unstarCommand,
      },
    }),
  );
}
