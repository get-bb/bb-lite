import { z } from "zod";
import { shapeBehind, type ContractMember, type Op } from "./contract.js";
import type { Kernel, KernelInspection } from "./kernel.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ApiDescription {
  [contract: string]: { [member: string]: Json };
}

export interface ApiLock {
  version: string;
  shapes: { [id: string]: Json };
  contracts: ApiDescription;
}

export interface ApiChanges {
  breaking: string[];
  additive: string[];
}

const KINDS = ["op", "event", "slot", "live"];

function shapeOf(schema: z.ZodType): Json {
  try {
    const options = { unrepresentable: "any", io: "input" } as const;
    const { $schema: _, ...shape } = z.toJSONSchema(
      shapeBehind(schema),
      options,
    );
    return JSON.parse(JSON.stringify(shape)) as Json;
  } catch {
    return {};
  }
}

function doorsOf({ doors }: Op): Json {
  const { agent, cli, http } = doors;
  return {
    ...(agent === undefined ? {} : { agent: agent.name }),
    ...(cli === undefined ? {} : { cli: cli.path }),
    ...(http === undefined
      ? {}
      : {
          http: `${http.method} ${http.path}`,
          ...(http.aliases === undefined ? {} : { also: [...http.aliases] }),
        }),
  };
}

function memberOf(member: ContractMember): Json {
  if (member.type === "op") {
    const { kind, hooks, allow, internal } = member;
    return {
      type: "op",
      kind,
      hooks,
      allow,
      internal,
      ...(member.deprecated === null ? {} : { deprecated: member.deprecated }),
      doors: doorsOf(member),
      input: shapeOf(member.input),
      output: shapeOf(member.output),
    };
  }
  if (member.type === "event") {
    return { type: "event", payload: shapeOf(member.payload) };
  }
  if (member.type === "live") {
    return { type: "live", value: shapeOf(member.value) };
  }
  return { type: "slot", key: member.key, pick: member.pick };
}

export function explainMember(member: ContractMember): Json {
  const { description } = member;
  const described = {
    ...(memberOf(member) as { [key: string]: Json }),
    ...(description === undefined ? {} : { description }),
  };
  if (member.type !== "op") return described;
  const { agent, cli, http } = member.doors;
  const doors: { [key: string]: Json } = {};
  if (agent !== undefined) {
    const { name = member.name, description } = agent;
    doors.agent = { name, description };
  }
  if (cli !== undefined) {
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;
    doors.cli = {
      path: cli.path,
      summary: cli.summary,
      ...(cli.description === undefined
        ? {}
        : { description: cli.description }),
      positionals: [...(cli.positionals ?? [])],
      aliases: [...(cli.aliases ?? [])],
      flags: plain(cli.flags ?? {}),
      from: plain(cli.from ?? {}),
      constraints: plain(cli.constraints ?? []),
    };
  }
  if (http !== undefined) {
    const { method, path, aliases = [] } = http;
    doors.http = { method, path, aliases: [...aliases] };
  }
  return { ...described, doors };
}

type Described = { [key: string]: Json };

export interface KernelDescription {
  api: string;
  contracts: {
    id: string;
    plugin: string;
    members: Record<string, Described>;
  }[];
}

function stateOf(seen: KernelInspection, name: string): Described {
  const op = seen.ops.find((entry) => entry.name === name);
  if (op !== undefined) {
    const hookedBy = op.chain.map(({ plugin }) => plugin);
    return { implementedBy: op.owner, hookedBy };
  }
  const heard = seen.events.find((entry) => entry.name === name);
  if (heard !== undefined) return { listeners: heard.listeners };
  const slot = seen.slots.find((entry) => entry.name === name);
  if (slot !== undefined) return { filledBy: slot.entries };
  const live = seen.live.find((entry) => entry.name === name);
  return live === undefined ? {} : { providedBy: live.owner };
}

export function describeKernel(
  kernel: Pick<Kernel, "inspect" | "contracts">,
  contractId?: string,
): KernelDescription {
  const seen = kernel.inspect();
  const wanted = kernel
    .contracts()
    .filter(({ id }) => contractId === undefined || id === contractId);
  const contracts = wanted.map(({ id, plugin, members }) => {
    const described: Record<string, Described> = {};
    for (const [key, member] of Object.entries(members)) {
      const shape = explainMember(member) as Described;
      described[key] = { ...shape, ...stateOf(seen, member.name) };
    }
    return { id, plugin, members: described };
  });
  return { api: seen.api, contracts };
}

export function describeApi(exported: Record<string, unknown>): ApiDescription {
  const described: ApiDescription = {};
  for (const name of Object.keys(exported).sort()) {
    const value = exported[name];
    const listed = typeof value !== "object" || Array.isArray(value);
    if (listed || value === null) continue;
    const members = Object.entries(value as Record<string, ContractMember>);
    const isContract =
      members.length > 0 &&
      members.every(([, member]) => KINDS.includes(member?.type));
    if (!isContract) continue;
    const entries = members.map(([key, member]) => [key, memberOf(member)]);
    described[name] = Object.fromEntries(entries) as { [key: string]: Json };
  }
  return described;
}

const SHAPED = ["input", "output", "payload", "value", "item"];

export interface TypeShapes {
  [contract: string]: { [member: string]: { [field: string]: Json } };
}

export function withTypes(
  described: ApiDescription,
  types: TypeShapes,
): ApiDescription {
  const merged: ApiDescription = {};
  for (const [contract, members] of Object.entries(described)) {
    merged[contract] = {};
    for (const [key, member] of Object.entries(members)) {
      const known = types[contract]?.[key] ?? {};
      const filled = Object.entries(known).filter(([name]) => {
        const shape = field(member, name);
        return shape === undefined || same(shape, {});
      });
      merged[contract][key] = {
        ...(member as { [key: string]: Json }),
        ...Object.fromEntries(filled),
      };
    }
  }
  return merged;
}
const SHARED_FROM = 200;

function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function packApi(version: string, described: ApiDescription): ApiLock {
  const shapes: ApiLock["shapes"] = {};
  const share = (shape: Json): Json => {
    const text = JSON.stringify(shape);
    if (text.length < SHARED_FROM) return shape;
    let id = digest(text);
    while (id in shapes && JSON.stringify(shapes[id]) !== text) id += "x";
    shapes[id] = shape;
    return { $shape: id };
  };
  const contracts: ApiDescription = {};
  for (const [contract, members] of Object.entries(described)) {
    contracts[contract] = {};
    for (const [key, member] of Object.entries(members)) {
      const fields = Object.entries(member as { [key: string]: Json });
      const packed = fields.map(([name, value]) => [
        name,
        SHAPED.includes(name) ? share(value) : value,
      ]);
      contracts[contract][key] = Object.fromEntries(packed) as Json;
    }
  }
  return { version, shapes, contracts };
}

export function unpackApi({ shapes, contracts }: ApiLock): ApiDescription {
  const described: ApiDescription = {};
  for (const [contract, members] of Object.entries(contracts)) {
    described[contract] = {};
    for (const [key, member] of Object.entries(members)) {
      const fields = Object.entries(member as { [key: string]: Json });
      const whole = fields.map(([name, value]) => {
        const id = field(value, "$shape");
        return [name, typeof id === "string" ? (shapes[id] ?? {}) : value];
      });
      described[contract][key] = Object.fromEntries(whole) as Json;
    }
  }
  return described;
}

function same(left: Json | undefined, right: Json | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function field(value: Json | undefined, name: string): Json | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value[name];
}

function keysOf(value: Json | undefined): string[] {
  const object = value !== null && typeof value === "object";
  return object && !Array.isArray(value) ? Object.keys(value) : [];
}

function listOf(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

const WIDER = ["enum", "anyOf", "oneOf", "required"];

function widens(before: Json | undefined, after: Json | undefined): boolean {
  if (same(before, after)) return true;
  const plain = (value: Json | undefined): value is { [key: string]: Json } =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!plain(before) || !plain(after)) return false;
  return Object.entries(before).every(([key, old]) => {
    const next = after[key];
    if (!WIDER.includes(key)) return widens(old, next);
    if (!Array.isArray(old) || !Array.isArray(next)) return false;
    return old.every((each) => next.some((other) => widens(each, other)));
  });
}

function onlyAdds(
  before: Json | undefined,
  after: Json | undefined,
  deep = false,
): boolean {
  if (same(before, after)) return true;
  if (deep) return widens(before, after);
  const [was, now] = [field(before, "properties"), field(after, "properties")];
  if (was === undefined || now === undefined)
    return keysOf(before).length === 0;
  const kept = keysOf(was).every((key) =>
    same(field(was, key), field(now, key)),
  );
  return kept && same(field(before, "type"), field(after, "type"));
}

type Change = "same" | "adds" | "breaks";
type JsonObject = { [key: string]: Json };

function worst(changes: Change[]): Change {
  if (changes.includes("breaks")) return "breaks";
  return changes.includes("adds") ? "adds" : "same";
}

function plain(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectChange(before: JsonObject, after: JsonObject, given: boolean) {
  const [was, now] = [field(before, "properties"), field(after, "properties")];
  if (!plain(was) || !plain(now)) return "breaks";
  const needed = (source: Json, key: string) =>
    listOf(field(source, "required")).includes(key);
  const kept = Object.keys(was).map((key): Change => {
    if (!(key in now)) return "breaks";
    const firmer = !needed(before, key) && needed(after, key);
    const looser = needed(before, key) && !needed(after, key);
    const moved = (given ? looser : firmer) ? "breaks" : "same";
    const relaxed = firmer || looser ? "adds" : "same";
    return worst([moved, relaxed, entryChange(was[key], now[key], given)]);
  });
  const added = Object.keys(now)
    .filter((key) => !(key in was))
    .map((key): Change => (given || !needed(after, key) ? "adds" : "breaks"));
  return worst([...kept, ...added]);
}

function entryChange(
  before: Json | undefined,
  after: Json | undefined,
  given: boolean,
): Change {
  if (same(before, after)) return "same";
  if (before === undefined) return "adds";
  if (!plain(before) || !plain(after)) return "breaks";
  const [was, now] = [before.anyOf, after.anyOf];
  if (Array.isArray(was) || Array.isArray(now)) {
    const old = Array.isArray(was) ? was : [before];
    const next = Array.isArray(now) ? now : [after];
    const kept = old.every((each) =>
      next.some((other) => entryChange(each, other, given) !== "breaks"),
    );
    return kept ? "adds" : "breaks";
  }
  const [call, nextCall] = [before.fn, after.fn];
  if (plain(call) && plain(nextCall)) {
    const [params, nextParams] = [call.params, nextCall.params];
    if (!Array.isArray(params) || !Array.isArray(nextParams)) return "breaks";
    if (nextParams.length < params.length) return "breaks";
    const more = nextParams.length > params.length ? "adds" : "same";
    const passed = params.map((param, index) =>
      entryChange(param, nextParams[index], !given),
    );
    const returned = entryChange(call.returns, nextCall.returns, given);
    return worst([more, returned, ...passed]);
  }
  for (const [wrapper, flips] of [
    ["component", true],
    ["promise", false],
    ["items", false],
  ] as const) {
    if (!(wrapper in before) || !(wrapper in after)) continue;
    const side = flips ? !given : given;
    return entryChange(before[wrapper], after[wrapper], side);
  }
  if (before.type === "object" && after.type === "object") {
    return objectChange(before, after, given);
  }
  return "breaks";
}

function inputChange(before: Json, after: Json): "same" | "adds" | "breaks" {
  if (same(before, after)) return "same";
  if (!onlyAdds(before, after)) return "breaks";
  const required = (schema: Json) => listOf(field(schema, "required"));
  const added = required(after).filter(
    (key) => !required(before).includes(key),
  );
  return added.length === 0 ? "adds" : "breaks";
}

const HOOK_POWER = ["observe", "rewrite", "answer"];
const REACH = ["owner", "user", "member"];

function opChanges(name: string, before: Json, after: Json, out: ApiChanges) {
  const read = (source: Json, key: string) => field(source, key) ?? null;
  const [given, nowGiven] = [read(before, "input"), read(after, "input")];
  const hookPoint = read(before, "internal") === true;
  const received = hookPoint && onlyAdds(given, nowGiven, true);
  const input = received ? "adds" : inputChange(given, nowGiven);
  if (input === "breaks") out.breaking.push(`${name}: the input changed`);
  if (input === "adds") out.additive.push(`${name}: new optional input`);
  const [was, now] = [read(before, "output"), read(after, "output")];
  if (!same(was, now)) {
    if (onlyAdds(was, now, true)) {
      out.additive.push(`${name}: more in the output`);
    } else out.breaking.push(`${name}: the output changed`);
  }
  const rank = (scale: string[], source: Json, key: string) =>
    scale.indexOf(String(read(source, key)));
  for (const [key, scale] of [
    ["hooks", HOOK_POWER],
    ["allow", REACH],
  ] as const) {
    const [old, next] = [rank(scale, before, key), rank(scale, after, key)];
    if (next < old) out.breaking.push(`${name}: ${key} is narrower`);
    if (next > old) out.additive.push(`${name}: ${key} is wider`);
  }
  if (read(before, "kind") !== read(after, "kind")) {
    out.breaking.push(`${name}: read or write changed`);
  }
  if (read(before, "internal") === false && read(after, "internal") === true) {
    out.breaking.push(`${name}: no longer callable from outside`);
  }
  if (
    read(before, "deprecated") === null &&
    read(after, "deprecated") !== null
  ) {
    out.additive.push(`${name}: deprecated`);
  }
  const [oldDoors, newDoors] = [read(before, "doors"), read(after, "doors")];
  const served = [
    String(field(newDoors, "http")).split(" ")[1] ?? "",
    ...listOf(field(newDoors, "also")),
  ];
  for (const door of keysOf(oldDoors).filter((key) => key !== "also")) {
    const [old, next] = [field(oldDoors, door), field(newDoors, door)];
    if (same(old, next)) continue;
    const [method, path = ""] = String(old).split(" ");
    const moved =
      door === "http" &&
      String(next).startsWith(`${method} `) &&
      served.includes(path);
    if (moved) out.additive.push(`${name}: served at a new path too`);
    else out.breaking.push(`${name}: the ${door} door changed`);
  }
  for (const door of keysOf(newDoors)) {
    if (field(oldDoors, door) === undefined) {
      out.additive.push(`${name}: new ${door} door`);
    }
  }
}

export function compareApi(
  before: ApiDescription,
  after: ApiDescription,
): ApiChanges {
  const out: ApiChanges = { breaking: [], additive: [] };
  for (const [contract, members] of Object.entries(before)) {
    const current = after[contract];
    if (current === undefined) {
      out.breaking.push(`${contract}: removed`);
      continue;
    }
    for (const [key, old] of Object.entries(members)) {
      const name = `${contract}.${key}`;
      const next = current[key];
      if (next === undefined) out.breaking.push(`${name}: removed`);
      else if (same(old, next)) continue;
      else if (field(old, "type") !== field(next, "type")) {
        out.breaking.push(`${name}: is now a ${String(field(next, "type"))}`);
      } else if (field(old, "type") === "op") opChanges(name, old, next, out);
      else if (field(old, "type") === "slot") {
        const placed = ["key", "pick"].every((part) =>
          same(field(old, part), field(next, part)),
        );
        const entry = entryChange(
          field(old, "item"),
          field(next, "item"),
          false,
        );
        if (!placed)
          out.breaking.push(`${name}: the slot's key or pick changed`);
        if (entry === "breaks") out.breaking.push(`${name}: the entry changed`);
        if (entry === "adds")
          out.additive.push(`${name}: the entry takes more`);
      } else {
        const part = field(old, "type") === "event" ? "payload" : "value";
        const grew = onlyAdds(field(old, part), field(next, part), true);
        (grew ? out.additive : out.breaking).push(
          `${name}: the ${part} changed`,
        );
      }
    }
    for (const key of Object.keys(current)) {
      if (members[key] === undefined)
        out.additive.push(`${contract}.${key}: new`);
    }
  }
  for (const contract of Object.keys(after)) {
    if (before[contract] === undefined) out.additive.push(`${contract}: new`);
  }
  return out;
}
