import { describe, expect, test } from "vitest";
import { runScript, type ScriptGlobals } from "../script.js";

const globals = (overrides: Partial<ScriptGlobals> = {}): ScriptGlobals => ({
  args: { topic: "x" },
  agent: async (prompt) => `answer to ${String(prompt)}`,
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
    for (const code of [
      "return Date.now()",
      "return Math.random()",
      "return eval('1')",
      "return (() => {}).constructor('return 1')()",
    ]) {
      await expect(runScript(code, globals())).rejects.toThrow();
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
