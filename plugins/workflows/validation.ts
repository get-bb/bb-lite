import { Ajv, type ValidateFunction } from "ajv";

const SUPPORTED = new Set([
  "$comment",
  "additionalProperties",
  "const",
  "default",
  "deprecated",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "nullable",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "writeOnly",
]);
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 4096;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function check(schema: unknown, path: string, depth: number, count: number[]) {
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) throw new Error(`${path} must be an object`);
  count[0] = (count[0] ?? 0) + 1;
  if ((count[0] ?? 0) > MAX_NODES) {
    throw new Error(`${path} exceeds the ${MAX_NODES}-node limit`);
  }
  if (depth > MAX_DEPTH) {
    throw new Error(`${path} exceeds the maximum depth of ${MAX_DEPTH}`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) {
      throw new Error(`${path} uses unsupported keyword "${key}"`);
    }
  }
  const { properties, items, additionalProperties } = schema;
  if (properties !== undefined) {
    if (!isObject(properties)) {
      throw new Error(`${path}.properties must be an object`);
    }
    for (const [name, child] of Object.entries(properties)) {
      check(child, `${path}.properties.${name}`, depth + 1, count);
    }
  }
  if (items !== undefined) check(items, `${path}.items`, depth + 1, count);
  if (additionalProperties !== undefined) {
    check(
      additionalProperties,
      `${path}.additionalProperties`,
      depth + 1,
      count,
    );
  }
}

const ajv = new Ajv({ allErrors: false, strict: false });
const compiled = new Map<string, ValidateFunction>();

export type Validator = (value: unknown) => string | null;

export function compileSchema(schema: unknown, path = "schema"): Validator {
  const text = JSON.stringify(schema);
  if (Buffer.byteLength(text) > MAX_SCHEMA_BYTES) {
    throw new Error(`${path} exceeds the ${MAX_SCHEMA_BYTES} byte limit`);
  }
  let validate = compiled.get(text);
  if (validate === undefined) {
    check(schema, path, 0, [0]);
    validate = ajv.compile(JSON.parse(text) as object);
    compiled.set(text, validate);
  }
  const fn = validate;
  return (value) =>
    fn(value) ? null : ajv.errorsText(fn.errors, { dataVar: "value" });
}
