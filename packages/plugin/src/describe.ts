import { z } from "zod";
import { shapeBehind, type ContractMember, type Op } from "./contract.js";

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

const SHAPED = ["input", "output", "payload", "value"];
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

function onlyAdds(before: Json | undefined, after: Json | undefined): boolean {
  if (same(before, after)) return true;
  const [was, now] = [field(before, "properties"), field(after, "properties")];
  if (was === undefined || now === undefined)
    return keysOf(before).length === 0;
  const kept = keysOf(was).every((key) =>
    same(field(was, key), field(now, key)),
  );
  return kept && same(field(before, "type"), field(after, "type"));
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
  const input = inputChange(read(before, "input"), read(after, "input"));
  if (input === "breaks") out.breaking.push(`${name}: the input changed`);
  if (input === "adds") out.additive.push(`${name}: new optional input`);
  const [was, now] = [read(before, "output"), read(after, "output")];
  if (!same(was, now)) {
    if (onlyAdds(was, now)) out.additive.push(`${name}: more in the output`);
    else out.breaking.push(`${name}: the output changed`);
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
        out.breaking.push(`${name}: the slot's key or pick changed`);
      } else {
        const part = field(old, "type") === "event" ? "payload" : "value";
        const grew = onlyAdds(field(old, part), field(next, part));
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
