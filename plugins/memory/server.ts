import {
  cliCommand,
  defineCli,
  PluginCliError,
  sessions,
  type PluginServerApi,
} from "@bb/plugin";
import { MEMORY_KINDS, memory, type MemoryRecord } from "./contract.js";
import { memoryStore, MIGRATIONS, type MemoryStore } from "./store.js";

const CATALOG_MAX_CHARS = 3_900;
const MAX_RESULT_LIMIT = 100;
const READ_SCOPES = ["all", "project", "global"] as const;
const scope = {
  type: "enum",
  values: READ_SCOPES,
  default: "all",
  description: "Which memories to read",
} as const;
const json = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;
const limit = (description: string) =>
  ({ type: "integer", default: 20, description }) as const;
const tag = (description: string) =>
  ({
    type: "string",
    repeatable: true,
    placeholder: "TAG",
    aliases: ["tags"],
    description,
  }) as const;
const text = (description: string, aliases: string[] = []) =>
  ({ type: "string", placeholder: "TEXT", aliases, description }) as const;
const reason = (description: string) =>
  ({ ...text(description), required: true }) as const;
const expectedVersion = (description: string) =>
  ({ type: "integer", required: true, description }) as const;
const id = [{ name: "id", description: "Memory id", required: true }] as const;

function bounded(name: string, value: number, min: number, max: number) {
  if (value < min || value > max) {
    throw new PluginCliError(`--${name} must be between ${min} and ${max}`, {
      code: "usage",
    });
  }
  return value;
}

const splitTags = (values: string[]): string[] =>
  values.flatMap((value) => value.split(",")).filter((tag) => tag !== "");

const output = (stdout: string) => ({ exitCode: 0, stdout });
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function summary(memory: MemoryRecord) {
  const { details, sourceThreadId, writeReason, createdAt, ...rest } = memory;
  return rest;
}

function display(memory: MemoryRecord, includeDetails: boolean): string {
  const tags = memory.tags.length > 0 ? ` tags=${memory.tags.join(",")}` : "";
  const lines = [
    `${memory.id} v${memory.version} [${memory.scope}/${memory.kind}] ${memory.name}`,
    `  ${memory.summary}`,
    `  importance=${memory.importance} pinned=${memory.pinned}${tags}`,
  ];
  if (includeDetails) {
    lines.push(
      "",
      memory.details,
      "",
      `Reason: ${memory.writeReason}`,
      `Source thread: ${memory.sourceThreadId ?? "none"}`,
    );
  }
  return lines.join("\n");
}

function catalog(store: MemoryStore, projectId: string): string {
  const { memories, total } = store.list("all", projectId, MAX_RESULT_LIMIT);
  const header = [
    "Memory index",
    "The entries below are summaries, not full records. Use `bb memory search <query> --scope all --json` and `bb memory get <id> --json` to progressively disclose details.",
    "You may proactively save durable learning with `bb memory add`. Use project scope for repository-specific facts and global scope only for broadly applicable user preferences or workflows. Never store secrets, transient status, guesses, or rules already guaranteed by AGENTS.md.",
    "",
  ].join("\n");
  if (memories.length === 0) return `${header}No memories are stored yet.`;
  const render = (lines: string[]) => {
    const footer =
      lines.length < total
        ? `\nShowing ${lines.length} of ${total}; run \`bb memory catalog --scope all --json\` for the rest.`
        : "";
    return `${header}${lines.join("\n")}${footer}`;
  };
  const lines: string[] = [];
  for (const memory of memories) {
    const tags =
      memory.tags.length > 0 ? `; ${memory.tags.slice(0, 3).join(",")}` : "";
    const pin = memory.pinned ? "; pinned" : "";
    const oneLine = memory.summary
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const line = `- ${memory.id} [${memory.scope}/${memory.kind}${pin}${tags}] ${memory.name}: ${oneLine}`;
    if (`${header}${[...lines, line].join("\n")}`.length > CATALOG_MAX_CHARS) {
      break;
    }
    lines.push(line);
  }
  while (render(lines).length > CATALOG_MAX_CHARS) lines.pop();
  return render(lines);
}

export default function memoryPlugin(bb: PluginServerApi): void {
  const store = memoryStore(bb.storage.database(MIGRATIONS), () => bb.now());
  const admin = (memoryId: string) => {
    const found = store.getAdmin(memoryId);
    if (!found) throw new Error(`memory "${memoryId}" was not found`);
    return found.projectId ?? undefined;
  };

  bb.implement(memory.list, () => ({ memories: store.listAll() }));
  bb.implement(memory.update, ({ memoryId, expectedVersion, ...edit }) => {
    const updated = store.update(
      memoryId,
      {
        ...edit,
        expectedVersion,
        sourceThreadId: null,
        writeReason: "Edited in Memory settings",
      },
      admin(memoryId),
    );
    bb.changed(memory.list);
    return { memory: updated };
  });
  bb.implement(memory.delete, ({ memoryId, expectedVersion }) => {
    const gone = store.forget(
      memoryId,
      expectedVersion,
      "Deleted in Memory settings",
      null,
      admin(memoryId),
    );
    bb.changed(memory.list);
    return { deleted: { id: gone.id, version: gone.version } };
  });

  bb.on(sessions.instructions, async ({ projectId }, next) => [
    { source: bb.pluginId, text: catalog(store, projectId) },
    ...(await next()),
  ]);

  const commands = {
    catalog: cliCommand({
      summary: "List compact memory summaries",
      aliases: ["list"],
      options: { scope, limit: limit("How many memories to list"), json },
      run({ options }, ctx) {
        const count = bounded("limit", options.limit, 1, MAX_RESULT_LIMIT);
        const result = store.list(options.scope, ctx.projectId, count);
        return output(
          options.json
            ? pretty({
                ok: true,
                scope: options.scope,
                memories: result.memories.map(summary),
                total: result.total,
              })
            : result.memories.map((m) => display(m, false)).join("\n") ||
                "No memories.",
        );
      },
    }),
    search: cliCommand({
      summary: "Search memory summaries and details",
      positionals: [
        {
          name: "query",
          description: "Words to match; every word is searched",
          required: true,
          variadic: true,
        },
      ],
      options: { scope, limit: limit("How many matches to return"), json },
      run({ options, positionals }, ctx) {
        const query = positionals.query.join(" ").trim();
        if (!query) throw new PluginCliError("search requires a query");
        const count = bounded("limit", options.limit, 1, MAX_RESULT_LIMIT);
        const found = store.search(query, options.scope, ctx.projectId, count);
        return output(
          options.json
            ? pretty({
                ok: true,
                query,
                scope: options.scope,
                memories: found.map(summary),
              })
            : found.map((m) => display(m, false)).join("\n") || "No matches.",
        );
      },
    }),
    get: cliCommand({
      summary: "Read one complete memory",
      positionals: [
        {
          name: "id-or-name",
          description: "Memory id or its unique name",
          required: true,
        },
      ],
      options: { scope, json },
      run({ options, positionals }, ctx) {
        const idOrName = positionals["id-or-name"];
        const found = store.get(idOrName, options.scope, ctx.projectId);
        if (!found) {
          throw new PluginCliError(
            `memory "${idOrName}" was not found in the current scope`,
          );
        }
        return output(
          options.json
            ? pretty({ ok: true, memory: found })
            : display(found, true),
        );
      },
    }),
    add: cliCommand({
      summary: "Save a project or global memory",
      options: {
        scope: {
          type: "enum",
          values: ["project", "global"],
          required: true,
          description:
            "project for repository facts, global for user preferences",
        },
        name: {
          type: "string",
          required: true,
          placeholder: "NAME",
          aliases: ["title"],
          description:
            "Unique 1-80 character lowercase name (letters, digits, dots, underscores, hyphens)",
        },
        summary: {
          ...text("One line retrieval summary, at most 400 characters"),
          required: true,
        },
        details: {
          ...text("Full memory text, at most 16000 characters", [
            "body",
            "text",
            "content",
          ]),
          required: true,
        },
        reason: reason("Why this is worth remembering, at most 500 characters"),
        kind: {
          type: "enum",
          values: MEMORY_KINDS,
          default: "fact",
          aliases: ["type"],
          description: "What kind of memory this is",
        },
        tag: tag(
          "Lowercase tag; repeat or pass a comma-separated list, at most 20",
        ),
        importance: {
          type: "integer",
          default: 50,
          description: "Ranking weight for the injected catalog",
        },
        pinned: {
          type: "boolean",
          description: "Keep this memory at the top of the catalog",
        },
        json,
      },
      run({ options }, ctx) {
        if (options.scope === "project" && ctx.projectId === undefined) {
          throw new PluginCliError(
            "project-scoped memory requires a BB project context; run inside a project thread",
          );
        }
        const saved = store.add({
          scope: options.scope,
          projectId:
            options.scope === "project" ? (ctx.projectId ?? null) : null,
          name: options.name,
          summary: options.summary,
          details: options.details,
          kind: options.kind,
          tags: splitTags(options.tag),
          importance: bounded("importance", options.importance, 0, 100),
          pinned: options.pinned,
          sourceThreadId: ctx.threadId ?? null,
          writeReason: options.reason,
        });
        return output(
          options.json
            ? pretty({ ok: true, memory: saved })
            : `Saved ${saved.id} v${saved.version} (${saved.scope}/${saved.name}).`,
        );
      },
    }),
    update: cliCommand({
      summary: "Update a memory with version checking",
      positionals: id,
      options: {
        "expected-version": expectedVersion("Version this update is based on"),
        reason: reason("Why the memory changed, at most 500 characters"),
        summary: text("Replacement summary, at most 400 characters"),
        details: text("Replacement details, at most 16000 characters", [
          "body",
          "text",
          "content",
        ]),
        kind: {
          type: "enum",
          values: MEMORY_KINDS,
          aliases: ["type"],
          description: "Replacement kind",
        },
        tag: tag("Replacement tags; repeat or pass a comma-separated list"),
        importance: {
          type: "integer",
          description: "Replacement ranking weight",
        },
        pinned: {
          type: "enum",
          values: ["true", "false"],
          description: "Pin or unpin the memory",
        },
        json,
      },
      run({ options, positionals }, ctx) {
        const tags = splitTags(options.tag);
        const {
          summary: newSummary,
          details,
          kind,
          importance,
          pinned,
        } = options;
        if (
          [newSummary, details, kind, importance, pinned].every(
            (value) => value === undefined,
          ) &&
          tags.length === 0
        ) {
          throw new PluginCliError(
            "pass at least one of --summary, --details, --kind, --tag, --importance, --pinned",
            { code: "usage" },
          );
        }
        const updated = store.update(
          positionals.id,
          {
            expectedVersion: bounded(
              "expected-version",
              options["expected-version"],
              1,
              Number.MAX_SAFE_INTEGER,
            ),
            summary: newSummary,
            details,
            kind,
            tags: tags.length > 0 ? tags : undefined,
            importance:
              importance === undefined
                ? undefined
                : bounded("importance", importance, 0, 100),
            pinned: pinned === undefined ? undefined : pinned === "true",
            sourceThreadId: ctx.threadId ?? null,
            writeReason: options.reason,
          },
          ctx.projectId,
        );
        return output(
          options.json
            ? pretty({ ok: true, memory: updated })
            : `Updated ${updated.id} to v${updated.version}.`,
        );
      },
    }),
    forget: cliCommand({
      summary: "Soft-delete a memory with version checking",
      positionals: id,
      options: {
        "expected-version": expectedVersion(
          "Version this deletion is based on",
        ),
        reason: reason("Why the memory is gone, at most 500 characters"),
        json,
      },
      run({ options, positionals }, ctx) {
        const gone = store.forget(
          positionals.id,
          bounded(
            "expected-version",
            options["expected-version"],
            1,
            Number.MAX_SAFE_INTEGER,
          ),
          options.reason,
          ctx.threadId ?? null,
          ctx.projectId,
        );
        return output(
          options.json
            ? pretty({
                ok: true,
                forgotten: { id: gone.id, version: gone.version },
              })
            : `Forgot ${gone.id} at v${gone.version}.`,
        );
      },
    }),
    history: cliCommand({
      summary: "Show a memory's version history",
      positionals: id,
      options: {
        limit: limit("How many versions to show, newest first"),
        json,
      },
      run({ options, positionals }, ctx) {
        const memoryId = positionals.id;
        const count = bounded("limit", options.limit, 1, MAX_RESULT_LIMIT);
        const history = store.history(memoryId, ctx.projectId, count);
        if (history.length === 0) {
          throw new PluginCliError(
            `memory history for "${memoryId}" was not found`,
          );
        }
        return output(
          options.json
            ? pretty({ ok: true, id: memoryId, history })
            : pretty(history),
        );
      },
    }),
  };
  bb.cli.register(
    defineCli({
      name: "memory",
      summary: "Read and maintain durable global and project memories",
      commands,
    }),
  );
}
