import { OpError, type HttpDoor, type Kernel } from "@bb/plugin";
import { ZodError } from "zod";
import { problemOf, type ApiApp } from "@bb/server-kit/http/api";
import { invalidRequest } from "@bb/server-kit/http/errors";

const OK = { ok: true } as const;

interface Incoming {
  req: {
    query(): Record<string, string>;
    param(): Record<string, string>;
    text(): Promise<string>;
  };
}

async function fieldsOf(c: Incoming, door: HttpDoor): Promise<object> {
  if (door.method === "GET") return c.req.query();
  const text = await c.req.text();
  let body: unknown = {};
  try {
    if (text.trim() !== "") body = JSON.parse(text);
  } catch {
    throw invalidRequest("Invalid JSON request body");
  }
  if (door.body !== undefined) return { [door.body]: body };
  return typeof body === "object" && body !== null ? body : {};
}

function rejected(error: unknown): never {
  const invalid = error instanceof OpError && error.code === "invalid_input";
  if (invalid && error.cause instanceof ZodError) {
    throw invalidRequest(problemOf(error.cause));
  }
  throw error;
}

function shapeOf(path: string): string {
  const open = (segment: string) => (segment.startsWith(":") ? "1" : "0");
  return path.split("/").map(open).join("");
}

export function registerOpDoors(app: ApiApp, kernel: Kernel): void {
  const offered = kernel.ops().flatMap(({ op, owner }) => {
    const door = op.doors.http;
    return door === undefined || owner === null ? [] : [{ op, door }];
  });
  const shapes = new Map(offered.map(({ door }) => [door, shapeOf(door.path)]));
  const shape = (door: HttpDoor) => shapes.get(door) ?? "";
  offered.sort((left, right) =>
    shape(left.door).localeCompare(shape(right.door)),
  );
  for (const { op, door } of offered) {
    app.on(door.method, door.path, async (c) => {
      const input = { ...(await fieldsOf(c, door)), ...c.req.param() };
      const result = await kernel.call(op, input).catch(rejected);
      if (result === null && door.empty === 204) return c.body(null, 204);
      return c.json(result === undefined ? OK : result, door.status ?? 200);
    });
  }
}
