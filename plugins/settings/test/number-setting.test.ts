import { describe, expect, it } from "vitest";
import { numberSettingError } from "../app/lib/number-setting";

describe("numberSettingError", () => {
  it("accepts a number inside the range", () => {
    expect(numberSettingError({ min: 0, max: 10, integer: true }, "7")).toBe(
      null,
    );
    expect(numberSettingError({}, "-2.5")).toBe(null);
  });

  it("rejects a number outside the range, a fraction or no number", () => {
    const rule = { min: 0, max: 10, integer: true };
    const message = "Enter a whole number at least 0 and at most 10";
    expect(numberSettingError(rule, "50")).toBe(message);
    expect(numberSettingError(rule, "-1")).toBe(message);
    expect(numberSettingError(rule, "2.5")).toBe(message);
    expect(numberSettingError({ max: 3 }, "abc")).toBe(
      "Enter a number at most 3",
    );
  });
});
