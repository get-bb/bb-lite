export const BB_PI_EXTENSION_SOURCE = String.raw`
import { readFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";

const TO_BRIDGE_FD = 3;
const FROM_BRIDGE_FD = 4;

function send(message) {
  const buffer = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  let offset = 0;
  try {
    while (offset < buffer.length) {
      offset += writeSync(TO_BRIDGE_FD, buffer, offset, buffer.length - offset);
    }
  } catch {}
}

function lineReader(onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    const text = pending + (typeof chunk === "string" ? chunk : decoder.write(chunk));
    const lines = text.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  };
}

const CARRIED = [
  "description", "title", "default", "examples", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength",
  "maxLength", "pattern", "format", "minItems", "maxItems",
];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function notes(schema) {
  const out = {};
  for (const key of CARRIED) if (schema[key] !== undefined) out[key] = schema[key];
  return out;
}

function literal(value) {
  return ["string", "number", "boolean"].includes(typeof value) ? Type.Literal(value) : null;
}

function objectSchema(schema) {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape = {};
  for (const [key, value] of Object.entries(asObject(schema.properties) ?? {})) {
    const property = asObject(value);
    if (!property) continue;
    const converted = convert(property);
    shape[key] = required.has(key) ? converted : Type.Optional(converted);
  }
  const options = notes(schema);
  if (schema.additionalProperties === false) options.additionalProperties = false;
  return Type.Object(shape, options);
}

function typed(type, schema) {
  const options = notes(schema);
  if (type === "object") return objectSchema(schema);
  if (type === "array") {
    const items = asObject(schema.items);
    return Type.Array(items ? convert(items) : Type.Unknown(), options);
  }
  if (type === "string") return Type.String(options);
  if (type === "number") return Type.Number(options);
  if (type === "integer") return Type.Integer(options);
  if (type === "boolean") return Type.Boolean(options);
  if (type === "null") return Type.Null(options);
  return Type.Unknown(options);
}

function convert(schema) {
  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.map(literal).filter(Boolean);
    if (literals.length === 1) return Type.Unsafe({ ...literals[0], ...notes(schema) });
    if (literals.length > 1) return Type.Union(literals, notes(schema));
  }
  const constant = schema.const === undefined ? null : literal(schema.const);
  if (constant) return Type.Unsafe({ ...constant, ...notes(schema) });
  for (const key of ["anyOf", "oneOf"]) {
    const variants = Array.isArray(schema[key])
      ? schema[key].map(asObject).filter(Boolean).map(convert)
      : [];
    if (variants.length > 0) return Type.Union(variants, notes(schema));
  }
  if (Array.isArray(schema.type)) {
    if (schema.type.length === 1) return typed(schema.type[0], schema);
    const variants = schema.type.map((type) => typed(type, { ...schema, description: undefined }));
    return Type.Union(variants, notes(schema));
  }
  if (schema.type === undefined) {
    return schema.properties ? objectSchema(schema) : Type.Unknown(notes(schema));
  }
  return typed(schema.type, schema);
}

function errorText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function bbExtension(pi) {
  const file = process.env.PI_BB_TOOLS_FILE;
  const tools = file ? JSON.parse(readFileSync(file, "utf8")) : [];
  const pending = new Map();
  let nextId = 0;

  const onLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const call = message.kind === "tool-result" ? pending.get(message.id) : undefined;
    if (!call) return;
    pending.delete(message.id);
    if (message.isError) call.reject(new Error(errorText(message.content) || "Tool call failed"));
    else call.resolve({ content: message.content, details: {} });
  };
  const read = lineReader(onLine);
  if (typeof Bun !== "undefined") {
    void (async () => {
      try {
        for await (const chunk of Bun.file(FROM_BRIDGE_FD).stream()) read(chunk);
      } catch {}
    })();
  } else {
    const input = new Socket({ fd: FROM_BRIDGE_FD, readable: true, writable: false });
    input.on("error", () => undefined);
    input.unref();
    input.on("data", read);
  }

  for (const tool of tools) {
    const schema = asObject(tool.inputSchema);
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: schema ? convert(schema) : Type.Object({}),
      async execute(toolCallId, params, signal) {
        nextId += 1;
        const id = "tc-" + String(nextId);
        const result = new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
        });
        signal?.addEventListener(
          "abort",
          () => {
            const call = pending.get(id);
            if (!call) return;
            pending.delete(id);
            call.reject(new Error("Tool call aborted"));
          },
          { once: true },
        );
        send({ kind: "tool-call", id, toolCallId, toolName: tool.name, arguments: params ?? {} });
        return result;
      },
    });
  }

  pi.on("session_start", async () => {
    if (tools.length > 0 && typeof pi.setActiveTools === "function") {
      const active = new Set(pi.getActiveTools?.() ?? []);
      const missing = tools.filter((tool) => !active.has(tool.name));
      for (const tool of missing) active.add(tool.name);
      if (missing.length > 0) pi.setActiveTools([...active]);
    }
    send({ kind: "ready" });
  });

  pi.on("agent_end", async (_event, ctx) => {
    send({ kind: "agent-end-leaf", leafId: ctx?.sessionManager?.getLeafId?.() ?? null });
  });
}
`;
