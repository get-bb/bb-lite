import * as core from "@bb/plugin";
import {
  describeApi,
  plugins,
  sessions,
  type ContractMember,
  type KernelInspection,
  type PluginServerApi,
} from "@bb/plugin";
import * as app from "@bb/plugin/app";
import * as runner from "@bb/runner";
import { z } from "zod";
import {
  pluginApi,
  type ApiContract,
  type ApiMember,
  type ApiReference,
  type MemberType,
} from "./contract.js";

interface Declared {
  member: ContractMember;
  source: string;
  described: Record<string, unknown>;
}

const SOURCES = { core, app, runner, "plugin-api-docs": { pluginApi } };

const shapeSchema = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});

function collectDeclared(): Map<string, Declared> {
  const found = new Map<string, Declared>();
  for (const [source, exported] of Object.entries(SOURCES)) {
    const values = exported as Record<string, unknown>;
    for (const [exportName, members] of Object.entries(describeApi(values))) {
      const value = values[exportName] as Record<string, ContractMember>;
      for (const [key, described] of Object.entries(members)) {
        const member = value[key];
        if (member === undefined || found.has(member.name)) continue;
        const fields = described as Record<string, unknown>;
        found.set(member.name, { member, source, described: fields });
      }
    }
  }
  return found;
}

const DECLARED = collectDeclared();

function kebab(name: string): string {
  return name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function cliUsage(
  path: string,
  positionals: readonly string[],
  input: unknown,
) {
  const shape = shapeSchema.safeParse(input);
  const properties = shape.success ? (shape.data.properties ?? {}) : {};
  const required = shape.success ? (shape.data.required ?? []) : [];
  const words = Object.keys(properties).map((field) => {
    const word = positionals.includes(field)
      ? `<${field}>`
      : `--${kebab(field)}`;
    return required.includes(field) ? word : `[${word}]`;
  });
  return ["bb", path, ...words].join(" ");
}

function declaredFacts({
  member,
  source,
  described,
}: Declared): ApiMember["facts"] {
  const facts = [{ label: "Declared by", value: source }];
  if (member.type === "slot") {
    facts.push({ label: "Pick", value: member.pick });
    if (member.key !== null) facts.push({ label: "Key", value: member.key });
  }
  if (member.type !== "op") return facts;
  const { cli, agent, http } = member.doors;
  if (cli !== undefined) {
    const usage = cliUsage(cli.path, cli.positionals ?? [], described.input);
    facts.push({ label: "CLI", value: `${usage}  (${cli.summary})` });
  }
  if (agent !== undefined) {
    facts.push({
      label: "Agent tool",
      value: `${agent.name}: ${agent.description}`,
    });
  }
  if (http !== undefined) {
    facts.push({ label: "HTTP", value: `${http.method} /api/v1${http.path}` });
  }
  if (!member.internal) {
    facts.push({ label: "App", value: `POST /api/v1/ops/${member.name}` });
  }
  return facts;
}

function list(values: string[]): string {
  const unique = [...new Set(values)];
  return unique.length === 0 ? "nobody" : unique.join(", ");
}

function buildReference(inspection: KernelInspection): ApiReference {
  const members = new Map<string, ApiMember>();
  const entry = (name: string, type: MemberType): ApiMember => {
    const existing = members.get(name);
    if (existing !== undefined) return existing;
    const declared = DECLARED.get(name);
    const created: ApiMember = {
      name,
      type,
      facts: declared === undefined ? [] : declaredFacts(declared),
      shapes: [],
    };
    if (declared !== undefined) {
      for (const label of ["input", "output", "payload", "value"]) {
        const shape = declared.described[label];
        if (shape !== undefined) created.shapes.push({ label, shape });
      }
    }
    members.set(name, created);
    return created;
  };
  for (const [name, { member }] of DECLARED) entry(name, member.type);
  for (const op of inspection.ops) {
    const facts = entry(op.name, "op").facts;
    if (!DECLARED.has(op.name)) {
      facts.push({ label: "Doors", value: list(op.doors) });
    }
    facts.push(
      { label: "Kind", value: op.kind },
      { label: "Allow", value: String(op.allow) },
      { label: "Hooks", value: String(op.hooks) },
      { label: "Implemented by", value: op.owner ?? "nobody" },
      { label: "Hooked by", value: list(op.chain.map((link) => link.plugin)) },
    );
    if (op.deprecated !== null) {
      facts.push({ label: "Deprecated", value: op.deprecated });
    }
  }
  for (const event of inspection.events) {
    const facts = entry(event.name, "event").facts;
    facts.push({ label: "Heard by", value: list(event.listeners) });
  }
  for (const slot of inspection.slots) {
    const facts = entry(slot.name, "slot").facts;
    if (!DECLARED.has(slot.name))
      facts.push({ label: "Pick", value: slot.pick });
    facts.push({ label: "Filled by", value: list(slot.entries) });
  }
  for (const live of inspection.live) {
    entry(live.name, "live").facts.push({
      label: "Provided by",
      value: live.owner,
    });
  }
  const contracts = new Map<string, ApiContract>();
  for (const member of members.values()) {
    const name = member.name.slice(0, member.name.lastIndexOf("."));
    const group = contracts.get(name) ?? { name, members: [] };
    group.members.push(member);
    contracts.set(name, group);
  }
  const sorted = [...contracts.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const group of sorted) {
    group.members.sort((a, b) => a.name.localeCompare(b.name));
  }
  const loaded = inspection.plugins.map(({ id }) => id).sort();
  return { api: inspection.api, plugins: loaded, contracts: sorted };
}

function memberMarkdown(member: ApiMember): string {
  const facts = member.facts.map(({ label, value }) => `- ${label}: ${value}`);
  const shapes = member.shapes.map(
    ({ label, shape }) =>
      `${label}:\n\n\`\`\`json\n${JSON.stringify(shape, null, 2)}\n\`\`\``,
  );
  const unknown =
    member.shapes.length === 0 && member.type !== "slot"
      ? ["Shapes are not published for contracts declared by plugins."]
      : [];
  return [
    `### ${member.name} (${member.type})`,
    facts.join("\n"),
    ...shapes,
    ...unknown,
  ].join("\n\n");
}

function contractMarkdown(group: ApiContract): string {
  const body = group.members.map(memberMarkdown);
  return [`## ${group.name}`, ...body].join("\n\n");
}

export function referenceMarkdown(
  reference: ApiReference,
  query: string | undefined,
): string {
  const header = `Plugin API ${reference.api}`;
  if (query === undefined || query.trim() === "") {
    const rows = reference.contracts.map(
      ({ name, members }) => `- ${name} (${members.length})`,
    );
    return [header, "Contracts:", rows.join("\n")].join("\n\n");
  }
  const word = query.trim().toLowerCase();
  const group = reference.contracts.find(
    ({ name }) => name.toLowerCase() === word,
  );
  if (group !== undefined) return contractMarkdown(group);
  const all = reference.contracts.flatMap(({ members }) => members);
  const exact = all.find(({ name }) => name.toLowerCase() === word);
  if (exact !== undefined) return memberMarkdown(exact);
  const matches = all.filter(({ name }) => name.toLowerCase().includes(word));
  if (matches.length === 0)
    return `Nothing in the plugin API matches "${query}".`;
  if (matches.length === 1 && matches[0]) return memberMarkdown(matches[0]);
  const rows = matches.map(({ name, type }) => `- ${name} (${type})`);
  return [`Matches for "${query}":`, rows.join("\n")].join("\n\n");
}

export default function pluginApiDocs(bb: PluginServerApi): void {
  const reference = async () =>
    buildReference(await bb.call(plugins.inspect, {}));
  bb.implement(pluginApi.list, reference);
  bb.implement(pluginApi.get, async ({ name }) =>
    referenceMarkdown(await reference(), name),
  );
  bb.add(sessions.mention, {
    id: "plugin-api",
    label: "Plugin API",
    async search({ query }) {
      const word = query.toLowerCase();
      const { contracts } = await reference();
      return contracts
        .flatMap(({ members }) => members)
        .filter(({ name }) => name.toLowerCase().includes(word))
        .slice(0, 20)
        .map(({ name, type }) => ({ id: name, title: name, subtitle: type }));
    },
    async resolve(itemId) {
      return { context: referenceMarkdown(await reference(), itemId) };
    },
  });
}
