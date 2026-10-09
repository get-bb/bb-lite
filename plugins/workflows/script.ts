import { parse, type Node } from "acorn";
import vm from "node:vm";
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
  phase(title: unknown): void;
  log(message: unknown): void;
  budget(): unknown;
}

const PRELUDE = `(() => {
  const bridge = globalThis.bridge;
  delete globalThis.bridge;
  const sync = (name, input) => {
    const out = JSON.parse(bridge(name, JSON.stringify(input)));
    if (out.error !== undefined) throw new Error(out.error);
    return out.value;
  };
  const agent = (prompt, options) =>
    new Promise((resolve, reject) =>
      bridge(
        "agent",
        JSON.stringify([prompt, options ?? null]),
        (out) => resolve(JSON.parse(out)),
        (error) => reject(new Error(error)),
      ),
    );
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
    parallel,
    pipeline,
    phase: (title) => { sync("phase", [title]); },
    log: (message) => { sync("log", [message]); },
    budget: () => sync("budget", []),
    args: sync("args", []),
  });
})();`;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function runScript(
  body: string,
  globals: ScriptGlobals,
): Promise<unknown> {
  const sync = (name: string, input: unknown[]): unknown => {
    if (name === "phase") return globals.phase(input[0]) ?? null;
    if (name === "log") return globals.log(input[0]) ?? null;
    if (name === "budget") return globals.budget();
    if (name === "args") return globals.args ?? null;
    throw new Error(`Unknown workflow function ${name}`);
  };
  const bridge = (
    name: string,
    json: string,
    resolve?: (out: string) => void,
    reject?: (error: string) => void,
  ): string => {
    try {
      const input = z.array(z.unknown()).parse(JSON.parse(json));
      if (name === "agent") {
        globals.agent(input[0], input[1] ?? undefined).then(
          (value) => resolve?.(JSON.stringify(value ?? null)),
          (error: unknown) => reject?.(message(error)),
        );
        return "null";
      }
      return JSON.stringify({ value: sync(name, input) });
    } catch (error) {
      return JSON.stringify({ error: message(error) });
    }
  };
  const context = vm.createContext(
    { bridge },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const options = { filename: "workflow.js", timeout: 1000 };
  vm.runInContext(PRELUDE, context, options);
  const code = `"use strict";
(async () => {
${body}
})().then((value) => JSON.stringify(value ?? null))`;
  const result: unknown = await vm.runInContext(code, context, options);
  return JSON.parse(z.string().parse(result));
}
