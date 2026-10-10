import { z } from "zod";

export type Side = "server" | "app";

export interface Described {
  api: string;
  contracts: {
    id: string;
    plugin: string;
    members: Record<string, Record<string, unknown>>;
  }[];
}

export interface Member {
  name: string;
  type: string;
  sides: Side[];
  described: Record<string, unknown>;
  states: { side: Side; state: Record<string, unknown> }[];
}

export interface Contract {
  id: string;
  plugin: string;
  sides: Side[];
  members: Member[];
}

export interface Fact {
  label: string;
  value: string;
}

export interface Uses {
  declares: string[];
  implements: string[];
  hooks: string[];
  listens: string[];
  fills: string[];
  provides: string[];
}

const doorsSchema = z.object({
  agent: z.object({ name: z.string(), description: z.string() }).optional(),
  cli: z
    .object({
      path: z.string(),
      summary: z.string(),
      positionals: z.array(z.string()),
      aliases: z.array(z.string()),
    })
    .optional(),
  http: z
    .object({
      method: z.string(),
      path: z.string(),
      aliases: z.array(z.string()),
    })
    .optional(),
});

const shapeSchema = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});

const text = z.string().nullable().catch(null);
const names = z.array(z.string()).catch([]);

const STATES: Record<string, [string, string][]> = {
  op: [
    ["implementedBy", "Implemented by"],
    ["hookedBy", "Hooked by"],
  ],
  event: [["listeners", "Heard by"]],
  slot: [["filledBy", "Filled by"]],
  live: [["providedBy", "Provided by"]],
};

export function mergeContracts(
  sets: { side: Side; described: Described; stateless?: boolean }[],
): Contract[] {
  const contracts = new Map<string, Contract>();
  for (const { side, described, stateless = false } of sets) {
    for (const { id, plugin, members } of described.contracts) {
      const found = contracts.get(id) ?? { id, plugin, sides: [], members: [] };
      contracts.set(id, found);
      if (!found.sides.includes(side)) found.sides.push(side);
      for (const [key, all] of Object.entries(members)) {
        const name = `${id}.${key}`;
        const known = found.members.find((member) => member.name === name);
        const {
          implementedBy,
          hookedBy,
          listeners,
          filledBy,
          providedBy,
          ...described
        } = all;
        const state = {
          implementedBy,
          hookedBy,
          listeners,
          filledBy,
          providedBy,
        };
        const states = stateless ? [] : [{ side, state }];
        if (known !== undefined) {
          known.sides.push(side);
          known.states.push(...states);
          continue;
        }
        const type = String(all.type);
        const sides: Side[] = [side];
        found.members.push({ name, type, sides, described, states });
      }
    }
  }
  const sorted = [...contracts.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  for (const group of sorted) {
    group.members.sort((a, b) => a.name.localeCompare(b.name));
  }
  return sorted;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

export function cliUsage(
  path: string,
  positionals: readonly string[],
  input: unknown,
): string {
  const shape = shapeSchema.safeParse(input);
  const properties = shape.success ? (shape.data.properties ?? {}) : {};
  const required = shape.success ? (shape.data.required ?? []) : [];
  const fields = [
    ...positionals.filter((field) => field in properties),
    ...Object.keys(properties).filter((field) => !positionals.includes(field)),
  ];
  const words = fields.map((field) => {
    const flag = z.object({ type: z.string() }).safeParse(properties[field]);
    const value =
      flag.success && flag.data.type === "boolean" ? "" : ` <${field}>`;
    const word = positionals.includes(field)
      ? `<${field}>`
      : `--${kebab(field)}${value}`;
    return required.includes(field) ? word : `[${word}]`;
  });
  return ["bb", path, ...words].join(" ");
}

function list(values: string[]): string {
  const unique = [...new Set(values)];
  return unique.length === 0 ? "nobody" : unique.join(", ");
}

export function sidesLabel(sides: Side[]): string {
  return sides.length > 1 ? "server and app" : (sides[0] ?? "server");
}

export function memberFacts(member: Member, plugin: string): Fact[] {
  const { described } = member;
  const { sides } = member;
  const facts: Fact[] = [
    { label: "Side", value: sidesLabel(sides) },
    { label: "Declared by", value: plugin },
  ];
  if (member.type === "op") {
    facts.push(
      { label: "Kind", value: String(described.kind) },
      { label: "Allow", value: String(described.allow) },
      { label: "Hooks", value: String(described.hooks) },
    );
    if (typeof described.deprecated === "string") {
      facts.push({ label: "Deprecated", value: described.deprecated });
    }
    const doors = doorsSchema.catch({}).parse(described.doors);
    if (doors.cli !== undefined) {
      const { path, summary, positionals, aliases } = doors.cli;
      const usage = cliUsage(path, positionals, described.input);
      facts.push({ label: "CLI", value: `${usage}  (${summary})` });
      if (aliases.length > 0) {
        const also = aliases.map((alias) => `bb ${alias}`).join(", ");
        facts.push({ label: "CLI aliases", value: also });
      }
    }
    if (doors.agent !== undefined) {
      const { name, description } = doors.agent;
      facts.push({ label: "Agent tool", value: `${name}: ${description}` });
    }
    if (doors.http !== undefined) {
      const { method, path, aliases } = doors.http;
      const paths = [path, ...aliases].map((each) => `/api/v1${each}`);
      facts.push({ label: "HTTP", value: `${method} ${paths.join(", ")}` });
    }
    if (described.internal !== true) {
      facts.push({ label: "App", value: `POST /api/v1/ops/${member.name}` });
    }
  }
  if (member.type === "slot") {
    facts.push({ label: "Pick", value: String(described.pick) });
    if (typeof described.key === "string") {
      facts.push({ label: "Key", value: described.key });
    }
  }
  for (const [key, label] of STATES[member.type] ?? []) {
    for (const { side, state } of member.states) {
      const raw = state[key];
      const value = Array.isArray(raw)
        ? list(names.parse(raw))
        : (text.parse(raw) ?? "nobody");
      const suffix = member.states.length > 1 ? ` (${side})` : "";
      facts.push({ label: `${label}${suffix}`, value });
    }
  }
  return facts;
}

export function memberShapes(
  member: Member,
): { label: string; shape: unknown }[] {
  return ["input", "output", "payload", "value"].flatMap((label) =>
    member.described[label] === undefined
      ? []
      : [{ label, shape: member.described[label] }],
  );
}

export function matching(contracts: Contract[], query: string): Contract[] {
  const word = query.trim().toLowerCase();
  if (word === "") return contracts;
  return contracts.flatMap((group) => {
    if (group.id.toLowerCase().includes(word)) return [group];
    const members = group.members.filter(({ name }) =>
      name.toLowerCase().includes(word),
    );
    return members.length === 0 ? [] : [{ ...group, members }];
  });
}

export const USES: [keyof Uses, string][] = [
  ["declares", "Declares"],
  ["implements", "Implements"],
  ["hooks", "Hooks"],
  ["listens", "Listens to"],
  ["fills", "Fills"],
  ["provides", "Provides"],
];
