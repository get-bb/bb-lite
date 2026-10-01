import { describe, expect, it } from "vitest";
import { RunnerError } from "@bb/runner";

describe("RunnerError", () => {
  it("carries a code and retryable flag", () => {
    const error = new RunnerError("stale_turn", "turn is gone");
    expect(error.code).toBe("stale_turn");
    expect(error.retryable).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });
});
