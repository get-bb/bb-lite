import { describe, expect, test } from "vitest";
import { clipUtf8, isTransient } from "../policy.js";
import { runScript, type ScriptGlobals } from "../script.js";

const globals = (overrides: Partial<ScriptGlobals> = {}): ScriptGlobals => ({
  args: { topic: "x" },
  agent: async (prompt) => `answer to ${String(prompt)}`,
  workflow: async (reference, args) => ({ reference, args }),
  phase: () => {},
  log: () => {},
  budget: () => ({ maxAgentCalls: 1 }),
  ...overrides,
});

describe("QuickJS sandbox", () => {
  test("runs agent calls, parallel and args through the bridge", async () => {
    const phases: unknown[] = [];
    const result = await runScript(
      `phase("one");
const [a, b] = await parallel([() => agent("a"), () => agent("b")]);
return { a, b, topic: args.topic, budget: budget() };`,
      globals({ phase: (title) => void phases.push(title) }),
    );
    expect(result).toEqual({
      a: "answer to a",
      b: "answer to b",
      topic: "x",
      budget: { maxAgentCalls: 1 },
    });
    expect(phases).toEqual(["one"]);
  });

  test("blocks nondeterminism and dynamic code", async () => {
    expect(
      await runScript("return [1 + 1, Math.max(2, 3)]", globals()),
    ).toEqual([2, 3]);
    const blocked: [string, RegExp][] = [
      ["return Date.now()", /property 'now' of undefined/],
      ["return Math.random()", /Math.random is unavailable/],
      ["return eval('1')", /not a function/],
      ["return Function('return 1')()", /not a function/],
      [
        "return (() => {}).constructor('return 1')()",
        /dynamic code generation is unavailable/,
      ],
      [
        "return (async () => {}).constructor('return 1')()",
        /dynamic code generation is unavailable/,
      ],
      ["Math.max = () => 4; return Math.max(1, 2)", /read-only/],
    ];
    for (const [code, error] of blocked) {
      await expect(runScript(code, globals()), code).rejects.toThrow(error);
    }
  });

  test("interrupts a runaway loop after an await", async () => {
    await expect(
      runScript(`await agent("x"); while (true) {}`, globals()),
    ).rejects.toThrow(/interrupted/i);
  });

  test("an agent failure rejects inside the script", async () => {
    const result = await runScript(
      `try { await agent("x"); } catch (error) { return error.message; }`,
      globals({ agent: async () => Promise.reject(new Error("boom")) }),
    );
    expect(result).toBe("boom");
  });
});

test("recognizes transient provider failures and clips notifications", () => {
  expect(isTransient("API Error 529 overloaded")).toBe(true);
  expect(isTransient("socket hang up")).toBe(true);
  expect(isTransient("Workflow stopped")).toBe(false);
  const clipped = clipUtf8("é".repeat(2000), 1024);
  expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(1024);
  expect(clipped.endsWith("[truncated]")).toBe(true);
});

test("passes workflow() calls through the bridge", async () => {
  const result = await runScript(
    `return await workflow("child", { a: 1 });`,
    globals(),
  );
  expect(result).toEqual({ reference: "child", args: { a: 1 } });
});
