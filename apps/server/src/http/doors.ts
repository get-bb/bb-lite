import type { HttpDoor, Kernel } from "@bb/plugin";
import { requireValid, type ApiApp } from "@bb/server-kit/http/api";
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

function bySpecificity(left: string, right: string): number {
  const ours = left.split("/");
  const theirs = right.split("/");
  for (const [index, segment] of ours.entries()) {
    const other = theirs[index];
    if (other === undefined) return 0;
    const open = segment.startsWith(":");
    if (open !== other.startsWith(":")) return open ? 1 : -1;
  }
  return 0;
}

export function registerOpDoors(app: ApiApp, kernel: Kernel): void {
  const offered = kernel.ops().flatMap(({ op, owner }) => {
    const door = op.doors.http;
    return door === undefined || owner === null ? [] : [{ op, door }];
  });
  offered.sort((left, right) => bySpecificity(left.door.path, right.door.path));
  for (const { op, door } of offered) {
    app.on(door.method, door.path, async (c) => {
      const input = { ...(await fieldsOf(c, door)), ...c.req.param() };
      requireValid(op.input, input);
      const result = await kernel.call(op, input);
      if (result === null && door.empty === 204) return c.body(null, 204);
      return c.json(result === undefined ? OK : result, door.status ?? 200);
    });
  }
}
