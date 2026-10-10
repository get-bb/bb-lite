import {
  audit,
  cliCommand,
  defineCli,
  type AuditEntry,
  type PluginServerApi,
} from "@bb/plugin";

function describe(entry: AuditEntry): string {
  const when = new Date(entry.at).toISOString().slice(0, 19).replace("T", " ");
  const thread = entry.threadId === null ? [] : [entry.threadId];
  const through = [entry.door, ...thread, ...entry.via].join(" > ");
  const hooks = entry.hooks.map(({ plugin, action }) => `${plugin} ${action}`);
  const outcome =
    entry.detail === null ? entry.outcome : `${entry.outcome}: ${entry.detail}`;
  const who = entry.userId ?? "system";
  const acted = hooks.length === 0 ? [] : [`[${hooks.join(", ")}]`];
  return [when, entry.op, who, through, ...acted, outcome].join("  ");
}

export default function plugin(bb: PluginServerApi): void {
  const list = cliCommand({
    summary: "Show who changed what, newest first",
    options: {
      user: { type: "string", description: "Only this user id" },
      op: { type: "string", description: "Only this operation" },
      thread: { type: "string", description: "Only this agent thread" },
      plugin: { type: "string", description: "Only records this plugin is in" },
      limit: { type: "integer", description: "How many records", default: 50 },
      json: { type: "boolean", description: "Print the records as JSON" },
    },
    async run({ options }) {
      const { json, limit, ...filters } = options;
      const entries = await bb.call(audit.list, { ...filters, limit });
      if (json) return { exitCode: 0, stdout: JSON.stringify(entries) };
      const lines = entries.map(describe);
      const stdout = lines.length === 0 ? "No records" : lines.join("\n");
      return { exitCode: 0, stdout };
    },
  });
  const summary = "See who changed what, through which door and plugin";
  bb.cli.register(defineCli({ name: "audit", summary, commands: { list } }));
}
