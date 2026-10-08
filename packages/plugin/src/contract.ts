import type { z } from "zod";

export type OpKind = "read" | "write";
export type HookPower = "observe" | "rewrite" | "answer";
export type Allow = "owner" | "member";

export interface DoorContext {
  threadId: string;
  projectId: string;
  hostId: string | null;
  providerId: string;
  providerCapabilities?: unknown;
}

export interface AgentDoor {
  name: string;
  description: string;
  instructions?: string;
  presentation?: unknown;
  enabledFor?(context: DoorContext): boolean;
}

export interface CliDoor<Input = unknown, Output = unknown> {
  path: string;
  summary: string;
  positionals?: readonly (keyof Input & string)[];
  print?(output: Output, input: Input): string;
}

export interface Doors<Input = unknown, Output = unknown> {
  agent?: AgentDoor;
  cli?: CliDoor<Input, Output>;
}

export interface Op<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  readonly type: "op";
  readonly name: string;
  readonly input: Input;
  readonly output: Output;
  readonly kind: OpKind;
  readonly hooks: HookPower;
  readonly allow: Allow;
  readonly secret: readonly string[];
  readonly internal: boolean;
  readonly doors: Doors;
}

export interface EventDef<Payload extends z.ZodType = z.ZodType> {
  readonly type: "event";
  readonly name: string;
  readonly payload: Payload;
}

export type SlotCheck<Item> = (
  item: Item,
  mine: readonly Item[],
) => string | null;

export interface Slot<Item = unknown> {
  readonly type: "slot";
  readonly name: string;
  readonly key: string | null;
  readonly pick: "one" | "many";
  readonly check: SlotCheck<Item> | null;
  readonly item?: Item;
}

export interface Live<Value extends z.ZodType = z.ZodType> {
  readonly type: "live";
  readonly name: string;
  readonly value: Value;
}

export interface SlotShape {
  readonly type: "slot";
  readonly name: string;
  readonly key: string | null;
  readonly pick: "one" | "many";
  readonly check: SlotCheck<never> | null;
}

export type ContractMember = Op | EventDef | SlotShape | Live;

export interface OpOptions<Input extends z.ZodType, Output extends z.ZodType> {
  input: Input;
  output: Output;
  kind?: OpKind;
  hooks?: HookPower;
  allow?: Allow;
  secret?: readonly string[];
  internal?: boolean;
  doors?: Doors<z.output<Input>, z.output<Output>>;
}

export function op<Input extends z.ZodType, Output extends z.ZodType>(
  options: OpOptions<Input, Output>,
): Op<Input, Output> {
  const { input, output } = options;
  const { kind = "read", hooks = "rewrite", allow = "member" } = options;
  const { secret = [], internal = false } = options;
  const doors = (options.doors ?? {}) as Doors;
  const shape = { input, output, kind, hooks, allow, secret, internal, doors };
  return { type: "op", name: "", ...shape };
}

export function event<Payload extends z.ZodType>(
  payload: Payload,
): EventDef<Payload> {
  return { type: "event", name: "", payload };
}

export function slot<Item>(
  options: {
    key?: keyof Item & string;
    pick?: "one" | "many";
    check?: SlotCheck<Item>;
  } = {},
): Slot<Item> {
  const { key = null, pick = "many", check = null } = options;
  return { type: "slot", name: "", key, pick, check };
}

export function service<Interface>(): Slot<Interface> {
  return { type: "slot", name: "", key: null, pick: "one", check: null };
}

export interface TableRef<Row = unknown> {
  readonly name: string;
  readonly row?: Row;
}

export function table<Row>(): Slot<TableRef<Row>> {
  return { type: "slot", name: "", key: null, pick: "one", check: null };
}

export function live<Value extends z.ZodType>(value: Value): Live<Value> {
  return { type: "live", name: "", value };
}

export function contract<const Members extends Record<string, ContractMember>>(
  id: string,
  members: Members,
): Members {
  const named = Object.entries(members).map(([key, member]) => [
    key,
    Object.freeze({ ...member, name: `${id}.${key}` }),
  ]);
  return Object.freeze(Object.fromEntries(named)) as Members;
}
