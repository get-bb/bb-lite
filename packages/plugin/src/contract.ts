import { z } from "zod";

export type OpKind = "read" | "write";
export type HookPower = "observe" | "rewrite" | "answer";
export type Allow = "owner" | "user" | "member";

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

export type CliContextField = "cwd" | "projectId" | "threadId";

export interface CliFlag {
  aliases?: readonly string[];
  split?: string;
  placeholder?: string;
  duration?: {
    min?: number;
    max?: number;
    units?: readonly ("ms" | "s" | "m" | "h" | "d")[];
  };
}

export type CliDoorConstraint<Field extends string = string> =
  | { kind: "exactly-one"; options: readonly Field[] }
  | { kind: "at-most-one"; options: readonly Field[] }
  | { kind: "at-least-one"; options: readonly Field[] }
  | { kind: "requires"; option: Field; needs: readonly Field[] };

export interface CliDoor<Input = unknown, Output = unknown> {
  path: string;
  summary: string;
  description?: string;
  aliases?: readonly string[];
  positionals?: readonly (keyof Input & string)[];
  flags?: { readonly [Field in keyof Input & string]?: CliFlag };
  from?: { readonly [Field in keyof Input & string]?: CliContextField };
  constraints?: readonly CliDoorConstraint<keyof Input & string>[];
  print?(output: Output, input: Input): string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpDoor {
  method: HttpMethod;
  path: string;
  status?: 200 | 201;
  empty?: 204;
  body?: string;
  aliases?: readonly string[];
}

export interface Doors<Input = unknown, Output = unknown> {
  agent?: AgentDoor;
  cli?: CliDoor<Input, Output>;
  http?: HttpDoor;
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
  readonly audit: boolean;
  readonly deprecated: string | null;
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
  audit?: boolean;
  deprecated?: string;
  doors?: Doors<z.output<Input>, z.output<Output>>;
}

export function op<Input extends z.ZodType, Output extends z.ZodType>(
  options: OpOptions<Input, Output>,
): Op<Input, Output> {
  const { input, output } = options;
  const { kind = "read", hooks = "rewrite", allow = "member" } = options;
  const { secret = [], internal = false, audit = true } = options;
  const doors = (options.doors ?? {}) as Doors;
  const deprecated = options.deprecated ?? null;
  const access = { kind, hooks, allow, secret, internal, audit, deprecated };
  return { type: "op", name: "", input, output, ...access, doors };
}

const shapes = new WeakMap<z.ZodType, z.ZodType>();

export function typed<Schema extends z.ZodType>(
  schema: Schema,
): z.ZodType<z.output<Schema>> {
  const unchecked = z.custom<z.output<Schema>>();
  shapes.set(unchecked, schema);
  return unchecked;
}

export function shapeBehind(schema: z.ZodType): z.ZodType {
  return shapes.get(schema) ?? schema;
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
