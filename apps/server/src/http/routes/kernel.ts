import type { ServerContext } from "../../context.js";
import type { ApiApp } from "../api.js";
import {
  ApiError,
  errorMessage,
  forbidden,
  invalidRequest,
  notFound,
  toApiError,
} from "../errors.js";

export function registerKernelRoutes(app: ApiApp, ctx: ServerContext): void {
  const { kernel } = ctx;

  app.get("/kernel", (c) => c.json(kernel.inspect()));

  app.post("/ops/:name", async (c) => {
    const name = c.req.param("name");
    const held = kernel.live(name);
    if (held !== null) {
      return c.json({ ok: true, result: kernel.value(held) ?? null });
    }
    const op = kernel.op(name);
    if (op === null) throw notFound(`Unknown operation "${name}"`);
    if (op.internal) {
      throw forbidden(`${name} is not offered outside the server`);
    }
    const text = await c.req.text();
    let input: unknown;
    try {
      input = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      throw invalidRequest("The request body must be JSON");
    }
    const result = await kernel.call(op, input).catch((error: unknown) => {
      if (toApiError(error) !== null) throw error;
      throw new ApiError(500, "handler_error", errorMessage(error));
    });
    return c.json({ ok: true, result: result ?? null });
  });
}
