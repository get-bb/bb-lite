import type { ApiApp, ApiEnv } from "@bb/plugin";
import type { z } from "zod";
import { invalidRequest } from "./errors.js";

export type AppEnv = ApiEnv;
export type { ApiApp };

type Issue = z.core.$ZodIssue;

const ABSENT = /, received undefined$/u;

function absent(issue: Issue): boolean {
  if (issue.code !== "invalid_union") return ABSENT.test(issue.message);
  return issue.errors.every(([first]) => first !== undefined && absent(first));
}

function expectedOf(issue: Issue): string[] {
  if (issue.code === "invalid_type") return [issue.expected];
  if (issue.code === "invalid_value")
    return issue.values.map((value) => JSON.stringify(value));
  if (issue.code !== "invalid_union") return [];
  const options = issue.errors.flatMap(([first]) =>
    first === undefined ? [] : expectedOf(first),
  );
  return [...new Set(options)];
}

export function problemOf(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return "Invalid request";
  const field = issue.path.map(String).join(".");
  const expected = expectedOf(issue);
  const missing = absent(issue) && expected.length > 0;
  if (field === "") return issue.message;
  const wanted = expected.join(" or ");
  if (missing) return `${field} is required (expected ${wanted})`;
  if (issue.code !== "invalid_union" || wanted === "") {
    return `${field}: ${issue.message}`;
  }
  return `${field}: Invalid input: expected ${wanted}`;
}

export function requireValid<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw invalidRequest(problemOf(parsed.error));
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
