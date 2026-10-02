import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { Endpoint } from "./endpoint.js";
import type {
  EndpointFromRouteDescriptor,
  RouteDefinition,
  RouteMethod,
  RouteParsedInput,
} from "./route-descriptor.js";

type HandlerReturn = Response | Promise<Response>;

type TypedJsonArgs<E> =
  E extends Endpoint<any, infer O, infer S extends ContentfulStatusCode, any>
    ? 200 extends S
      ? [data: O] | [data: O, status: S]
      : [data: O, status: S]
    : never;

type TypedContext<E, Path extends string> = Omit<Context<{}, Path>, "json"> & {
  json: (...args: TypedJsonArgs<E>) => Response;
};

type DescriptorHandler<
  Descriptor extends RouteDefinition,
  E extends EndpointFromRouteDescriptor<Descriptor>,
  ParsedInput extends RouteParsedInput<Descriptor["request"]>,
> = [ParsedInput] extends [never]
  ? (c: TypedContext<E, Descriptor["path"]>) => HandlerReturn
  : (
      c: TypedContext<E, Descriptor["path"]>,
      input: ParsedInput,
    ) => HandlerReturn;

type TypedDescriptorRegister<Method extends RouteMethod> = <
  Descriptor extends RouteDefinition<string, Method>,
  E extends EndpointFromRouteDescriptor<Descriptor>,
  ParsedInput extends RouteParsedInput<Descriptor["request"]>,
>(
  descriptor: Descriptor,
  handler: DescriptorHandler<Descriptor, E, ParsedInput>,
) => void;

interface TypedRoutesOptions {
  onValidationError?: (message: string) => Error;
}

type UntypedHandler = (c: Context, input?: unknown) => HandlerReturn;

const MISSING_INPUT_MESSAGE =
  /^Invalid input: expected .*, received undefined$/;

function validationMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const missing =
    issue.code === "invalid_type" &&
    issue.input === undefined &&
    MISSING_INPUT_MESSAGE.test(issue.message);
  return missing ? "Required" : issue.message;
}

export function typedRoutes(
  app: Hono<any, any, any>,
  options?: TypedRoutesOptions,
) {
  const makeError =
    options?.onValidationError ?? ((message: string) => new Error(message));

  async function requestInput(c: Context, source: "query" | "json") {
    if (source === "query") return c.req.query();
    try {
      return (await c.req.json()) as unknown;
    } catch {
      throw makeError("Invalid JSON request body");
    }
  }

  function register<Method extends RouteMethod>(method: Method) {
    const add = (descriptor: RouteDefinition, handler: UntypedHandler) => {
      const { request, path } = descriptor;
      if (request.source === "none" || request.source === "form") {
        app[method](path, (c) => handler(c));
        return;
      }
      const { schema, source } = request;
      app[method](path, async (c) => {
        const input = await requestInput(c, source);
        const parsed = schema.safeParse(input);
        if (!parsed.success) throw makeError(validationMessage(parsed.error));
        return handler(c, parsed.data);
      });
    };
    return add as unknown as TypedDescriptorRegister<Method>;
  }

  return {
    get: register("get"),
    post: register("post"),
    patch: register("patch"),
    del: register("delete"),
    put: register("put"),
  };
}
