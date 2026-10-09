import type { ApiApp, ApiEnv } from "@bb/plugin";
import type { z } from "zod";
import { invalidRequest } from "./errors.js";

export type AppEnv = ApiEnv;
export type { ApiApp };

const MISSING = /^Invalid input: expected .*, received undefined$/u;

export function requireValid<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  if (issue === undefined) throw invalidRequest("Invalid request");
  const missing =
    issue.code === "invalid_type" &&
    issue.input === undefined &&
    MISSING.test(issue.message);
  throw invalidRequest(missing ? "Required" : issue.message);
}

export async function readJsonBody<Schema extends z.ZodType>(
  context: { req: { json(): Promise<unknown> } },
  schema: Schema,
): Promise<z.output<Schema>> {
  const body = await context.req.json().catch(() => {
    throw invalidRequest("Invalid JSON request body");
  });
  return requireValid(schema, body);
}
