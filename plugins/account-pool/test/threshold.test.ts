import { expect, it } from "vitest";
import { parseSwitchThreshold, THRESHOLD_ERROR } from "../src/threshold.js";

it("accepts a quota fraction above 0 and at most 1", () => {
  expect(parseSwitchThreshold("0.9")).toEqual({ value: 0.9 });
  expect(parseSwitchThreshold(" 1 ")).toEqual({ value: 1 });
});

it("refuses values outside the fraction range with a readable message", () => {
  for (const raw of ["150", "1.01", "0", "-0.5", "", "  ", "abc", "Infinity"]) {
    expect(parseSwitchThreshold(raw)).toEqual({ error: THRESHOLD_ERROR });
  }
});
