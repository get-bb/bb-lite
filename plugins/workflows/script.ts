import { parse, type Node } from "acorn";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import { z } from "zod";

const phaseSchema = z
  .object({ title: z.string().min(1), detail: z.string().min(1).optional() })
  .strict();

export const metaSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "meta.name must be kebab-case"),
    description: z.string().min(1),
    phases: z
      .array(phaseSchema)
      .refine(
        (phases) =>
          new Set(phases.map((phase) => phase.title)).size === phases.length,
        "phase titles must be unique",
      )
      .optional(),
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
  })
  .strict();
export type WorkflowMeta = z.infer<typeof metaSchema>;

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  body: string;
}

type AstNode = Node & Record<string, unknown>;

function literal(node: AstNode): unknown {
  const fail = () => {
    throw new Error("meta must be a pure literal");
  };
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as AstNode[];
    if (quasis.length !== 1) fail();
    return (quasis[0]?.value as { cooked: string }).cooked;
  }
  if (node.type === "ArrayExpression") {
    return (node.elements as (AstNode | null)[]).map((item) =>
      item === null ? fail() : literal(item),
    );
  }
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const value = literal(node.argument as AstNode);
    return typeof value === "number" ? -value : fail();
  }
  if (node.type !== "ObjectExpression") return fail();
  const entries = (node.properties as AstNode[]).map((property) => {
    if (property.type !== "Property" || property.computed) return fail();
    const key = property.key as AstNode;
    const name = key.type === "Identifier" ? key.name : key.value;
    if (typeof name !== "string") return fail();
    return [name, literal(property.value as AstNode)] as const;
  });
  return Object.fromEntries(entries);
}

export function parseWorkflow(source: string): ParsedWorkflow {
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as unknown as AstNode;
  const first = (program.body as AstNode[])[0];
  const declaration = first?.declaration as AstNode | undefined;
  const declarator = (declaration?.declarations as AstNode[] | undefined)?.[0];
  const id = declarator?.id as AstNode | undefined;
  if (
    first?.type !== "ExportNamedDeclaration" ||
    declaration?.kind !== "const" ||
    id?.name !== "meta" ||
    declarator?.init === undefined
  ) {
    throw new Error(
      "A workflow must begin with `export const meta = { name, description }`",
    );
  }
  const meta = metaSchema.safeParse(literal(declarator.init as AstNode));
  if (!meta.success) {
    throw new Error(`Invalid meta: ${z.prettifyError(meta.error)}`);
  }
  return { meta: meta.data, body: source.slice(first.end) };
}

export interface ScriptGlobals {
  args: unknown;
  agent(prompt: unknown, options?: unknown): Promise<unknown>;
  workflow(reference: unknown, args?: unknown): Promise<unknown>;
  phase(title: unknown): void;
  log(message: unknown): void;
  budget(): unknown;
}

const PRELUDE = `(() => {
  const hostSync = globalThis.__sync;
  const hostAgent = globalThis.__agent;
  delete globalThis.__sync;
  delete globalThis.__agent;
  const sync = (name, input) => {
    const out = JSON.parse(hostSync(name, JSON.stringify(input)));
    if (out.error !== undefined) throw new Error(out.error);
    return out.value;
  };
  const host = (name, first, second) =>
    hostAgent(JSON.stringify([name, first, second ?? null])).then(JSON.parse);
  const agent = (prompt, options) => host("agent", prompt, options);
  const workflow = (reference, args) => host("workflow", reference, args);
  const parallel = (thunks) => Promise.all(
    thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)),
  );
  const pipeline = (items, ...stages) => Promise.all(
    items.map(async (item, index) => {
      let value = item;
      try {
        for (const stage of stages) value = await stage(value, item, index);
        return value;
      } catch {
        return null;
      }
    }),
  );
  Object.assign(globalThis, {
    agent,
    workflow,
    parallel,
    pipeline,
    phase: (title) => { sync("phase", [title]); },
    log: (message) => { sync("log", [message]); },
    budget: () => sync("budget", []),
    args: sync("args", []),
  });
  const forbidden = (name) => () => {
    throw new Error(name + " is unavailable in workflows");
  };
  const lock = (target, key, value) =>
    Object.defineProperty(target, key, {
      value,
      configurable: false,
      writable: false,
    });
  for (const fn of [
    () => {},
    async () => {},
    function* () {},
    async function* () {},
  ]) {
    lock(fn.constructor.prototype, "constructor", forbidden("dynamic code generation"));
  }
  lock(globalThis, "eval", undefined);
  lock(globalThis, "Function", undefined);
  lock(globalThis, "Date", undefined);
  lock(Math, "random", forbidden("Math.random"));
  Object.freeze(Math);
  Object.freeze(JSON);
})();`;

const MEMORY_LIMIT = 32 * 1024 * 1024;
const STACK_LIMIT = 512 * 1024;
const SYNC_DEADLINE_MS = 1000;
const quickJs = newQuickJSWASMModuleFromVariant(
  import("@jitl/quickjs-singlefile-cjs-release-sync"),
);

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function runScript(
  body: string,
  globals: ScriptGlobals,
  signal?: AbortSignal,
): Promise<unknown> {
  const sync = (name: string, input: unknown[]): unknown => {
    if (name === "phase") return globals.phase(input[0]) ?? null;
    if (name === "log") return globals.log(input[0]) ?? null;
    if (name === "budget") return globals.budget();
    if (name === "args") return globals.args ?? null;
    throw new Error(`Unknown workflow function ${name}`);
  };
  const runtime = (await quickJs).newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT);
  runtime.setMaxStackSize(STACK_LIMIT);
  let deadline = Number.POSITIVE_INFINITY;
  const enter = () => {
    deadline = Date.now() + SYNC_DEADLINE_MS;
  };
  runtime.setInterruptHandler(
    () => signal?.aborted === true || Date.now() > deadline,
  );
  const vm = runtime.newContext();
  let closed = false;
  const pump = () => {
    if (closed) return;
    enter();
    runtime.executePendingJobs().unwrap();
  };
  const define = (
    name: string,
    fn: (...handles: QuickJSHandle[]) => QuickJSHandle,
  ) => {
    const handle = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  try {
    define("__sync", (name, json) => {
      let out: string;
      try {
        const input = z
          .array(z.unknown())
          .parse(JSON.parse(vm.getString(json!)));
        out = JSON.stringify({ value: sync(vm.getString(name!), input) });
      } catch (error) {
        out = JSON.stringify({ error: message(error) });
      }
      return vm.newString(out);
    });
    define("__agent", (json) => {
      const deferred = vm.newPromise();
      const settle = (ok: boolean, text: string) => {
        if (closed || !deferred.alive) return;
        const handle = ok ? vm.newString(text) : vm.newError(text);
        if (ok) deferred.resolve(handle);
        else deferred.reject(handle);
        handle.dispose();
        deferred.dispose();
        pump();
      };
      const text = vm.getString(json!);
      void Promise.resolve()
        .then(() => {
          const [name, first, second] = z
            .tuple([z.enum(["agent", "workflow"]), z.unknown(), z.unknown()])
            .parse(JSON.parse(text));
          return name === "agent"
            ? globals.agent(first, second ?? undefined)
            : globals.workflow(first, second ?? undefined);
        })
        .then(
          (value) => settle(true, JSON.stringify(value ?? null)),
          (error: unknown) => settle(false, message(error)),
        );
      return deferred.handle;
    });
    enter();
    vm.evalCode(PRELUDE, "prelude.js").unwrap().dispose();
    enter();
    const promise = vm
      .evalCode(
        `"use strict";
(async () => {
${body}
})().then((value) => JSON.stringify(value ?? null))`,
        "workflow.js",
      )
      .unwrap();
    const settled = vm.resolvePromise(promise);
    promise.dispose();
    pump();
    const handle = (await settled).unwrap();
    const text = vm.getString(handle);
    handle.dispose();
    return JSON.parse(text);
  } catch (error) {
    if (signal?.aborted === true) throw new Error("Workflow cancelled");
    throw error;
  } finally {
    closed = true;
    vm.dispose();
    runtime.dispose();
  }
}
