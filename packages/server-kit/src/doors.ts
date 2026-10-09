import {
  threadEventItemPresentationSchema,
  type DynamicTool,
  type ToolCallResponse,
} from "@bb/domain";
import {
  defineCli,
  OpError,
  PluginCliError,
  ToolFailure,
  type CliCommand,
  type CliContextField,
  type CliDoor,
  type CliFlag,
  type CliOption,
  type CliPositional,
  type CliRegistration,
  type DoorContext,
  type Kernel,
  type Op,
} from "@bb/plugin";
import { z } from "zod";
import { errorMessage } from "@bb/server-kit/http/errors";

interface JsonProperty {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
}

interface JsonObject {
  properties?: Record<string, JsonProperty>;
  required?: string[];
}

type Decode = (raw: unknown) => unknown;
interface Field {
  key: string;
  flag: string;
  option: CliOption;
  decode: Decode;
}

function toolResponse(text: string, success: boolean): ToolCallResponse {
  return { contentItems: [{ type: "inputText", text }], success };
}

function shapeOf(op: Op): JsonObject {
  return z.toJSONSchema(op.input, { io: "input" }) as JsonObject;
}

function offered(kernel: Kernel, context: DoorContext): Op[] {
  return kernel.ops().flatMap(({ op, owner }) => {
    const door = op.doors.agent;
    if (door === undefined || owner === null) return [];
    return door.enabledFor?.(context) === false ? [] : [op];
  });
}

export function doorTools(kernel: Kernel, context: DoorContext): DynamicTool[] {
  return offered(kernel, context).map((op) => {
    const {
      name = op.name,
      description,
      presentation: look,
    } = op.doors.agent ?? { description: "" };
    const inputSchema = z.toJSONSchema(op.input, { io: "input" });
    const presentation = threadEventItemPresentationSchema.safeParse(look).data;
    const base = { name, description, inputSchema };
    return presentation === undefined ? base : { ...base, presentation };
  });
}

export function doorInstructions(
  kernel: Kernel,
  context: DoorContext,
): { source: string; text: string }[] {
  return offered(kernel, context).flatMap((op) => {
    const text = op.doors.agent?.instructions;
    return text?.trim() ? [{ source: op.name, text }] : [];
  });
}

export async function callDoorTool(
  kernel: Kernel,
  name: string,
  input: unknown,
  context: DoorContext & { signal: AbortSignal },
): Promise<ToolCallResponse | null> {
  const op = offered(kernel, context).find(
    (candidate) => candidate.doors.agent?.name === name,
  );
  if (op === undefined) return null;
  try {
    const result = await kernel.call(op, input, { signal: context.signal });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return toolResponse(text ?? "Done", true);
  } catch (error) {
    if (error instanceof ToolFailure) return toolResponse(error.message, false);
    const invalid = error instanceof OpError && error.code === "invalid_input";
    const prefix = invalid ? "Invalid arguments" : "Tool failed";
    return toolResponse(`${prefix}: ${errorMessage(error)}`, false);
  }
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function fieldOf(
  key: string,
  property: JsonProperty,
  required: boolean,
  declared: CliFlag = {},
) {
  const types = [property.type ?? []].flat();
  const description = property.description ?? key;
  const { aliases, placeholder, split, duration } = declared;
  const base = {
    description,
    ...(required ? { required } : {}),
    ...(aliases ? { aliases } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
  const flag = kebab(key);
  const plain: Decode = (raw) => raw;
  const field = (option: CliOption, decode = plain): Field => {
    return { key, flag, option, decode };
  };
  if (duration !== undefined) {
    return field({ ...base, ...duration, type: "duration" });
  }
  if (types.includes("boolean")) return field({ ...base, type: "boolean" });
  if (property.enum?.every((value) => typeof value === "string")) {
    const values = property.enum as string[];
    return field({ ...base, type: "enum", values });
  }
  if (types.includes("integer")) return field({ ...base, type: "integer" });
  if (types.includes("number")) {
    return field({ ...base, type: "string" }, (raw) => Number(raw));
  }
  if (types.includes("array")) {
    const many = { repeatable: true, ...(split ? { split } : {}) };
    return field({ ...base, ...many, type: "string" });
  }
  if (types.includes("string") || types.length === 0) {
    return field({ ...base, type: "string" });
  }
  const json: Decode = (raw) => {
    try {
      return JSON.parse(String(raw)) as unknown;
    } catch {
      throw new PluginCliError(`--${flag} must be JSON`, { code: "usage" });
    }
  };
  return field({ ...base, type: "string", placeholder: "json" }, json);
}

function printed(door: CliDoor, output: unknown, input: unknown): string {
  if (door.print !== undefined) return door.print(output, input);
  if (typeof output === "string") return output;
  return output === undefined ? "" : JSON.stringify(output, null, 2);
}

function doorCommand(kernel: Kernel, op: Op, door: CliDoor): CliCommand {
  const { properties = {}, required = [] } = shapeOf(op);
  const declared: Record<string, CliFlag | undefined> = door.flags ?? {};
  const sources: Record<string, CliContextField | undefined> = door.from ?? {};
  const fields = Object.entries(properties).map(([key, property]) =>
    fieldOf(
      key,
      property,
      required.includes(key) && sources[key] === undefined,
      declared[key],
    ),
  );
  const flagOf = (key: string) => kebab(key);
  const constraints = (door.constraints ?? []).map((constraint) =>
    constraint.kind === "requires"
      ? {
          kind: constraint.kind,
          option: flagOf(constraint.option),
          needs: constraint.needs.map(flagOf),
        }
      : { kind: constraint.kind, options: constraint.options.map(flagOf) },
  );
  const named: readonly string[] = door.positionals ?? [];
  const positionals: CliPositional[] = named.flatMap((key) => {
    const found = fields.find((field) => field.key === key);
    if (found === undefined) return [];
    const { description, required: needed, repeatable } = found.option;
    const shape = { name: found.flag, description };
    return [{ ...shape, required: needed, variadic: repeatable }];
  });
  const flags = fields.filter(({ key }) => !named.includes(key));
  const options: Record<string, CliOption> = Object.fromEntries(
    flags.map(({ flag, option }) => [flag, option]),
  );
  options.json = { type: "boolean", description: "Print the result as JSON" };
  return {
    summary: door.summary,
    ...(door.description ? { description: door.description } : {}),
    options,
    positionals,
    constraints,
    async run(parsed, context) {
      const given = { ...parsed.options, ...parsed.positionals };
      const input = Object.fromEntries(
        fields.flatMap(({ key, flag, decode }) => {
          const raw: unknown = given[flag];
          const empty = Array.isArray(raw) && raw.length === 0;
          return raw === undefined || empty ? [] : [[key, decode(raw)]];
        }),
      );
      const located = "cwd" in properties && input.cwd === undefined;
      if (located && context.cwd !== undefined) input.cwd = context.cwd;
      for (const [key, source] of Object.entries(sources)) {
        const known = source === undefined ? undefined : context[source];
        if (input[key] === undefined && known !== undefined) input[key] = known;
      }
      let output: unknown;
      try {
        output = await kernel.call(op, input);
      } catch (error) {
        if (!(error instanceof OpError)) throw error;
        throw new PluginCliError(error.message, { code: error.code });
      }
      if (parsed.options.json === true) {
        return { exitCode: 0, stdout: JSON.stringify(output ?? null, null, 2) };
      }
      return { exitCode: 0, stdout: printed(door, output, input) };
    },
  };
}

export function doorCli(
  kernel: Kernel,
  pluginId: string,
  summary: string,
): CliRegistration | null {
  const commands: Record<string, CliCommand> = {};
  let root: CliCommand | undefined;
  let name: string | undefined;
  for (const { op, owner } of kernel.ops()) {
    const door = op.doors.cli;
    if (door === undefined || owner !== pluginId) continue;
    const [first = "", ...rest] = door.path.trim().split(/\s+/u);
    name ??= first;
    if (first !== name) continue;
    const spelled = (door.aliases ?? []).flatMap((alias) => {
      const [head, ...tail] = alias.trim().split(/\s+/u);
      return head === name && tail.length > 0 ? [tail.join(" ")] : [];
    });
    const aliases = spelled.length === 0 ? {} : { aliases: spelled };
    const command = { ...doorCommand(kernel, op, door), ...aliases };
    if (rest.length === 0) root = command;
    else commands[rest.join(" ")] = command;
  }
  if (name === undefined) return null;
  return defineCli({ name, summary, commands, ...(root ? { root } : {}) });
}
