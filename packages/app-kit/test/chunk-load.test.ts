import { expect, it } from "vitest";
import {
  isChunkDownloadError,
  loadWithDownloadRetries,
} from "../lib/chunk-load";

const downloadError = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: http://x/assets/a.js",
  );

it("recognises chunk download errors only", () => {
  expect(isChunkDownloadError(downloadError())).toBe(true);
  expect(
    isChunkDownloadError(new Error("Importing a module script failed.")),
  ).toBe(true);
  expect(isChunkDownloadError(new Error("x is undefined"))).toBe(false);
  expect(isChunkDownloadError("Failed to fetch dynamically")).toBe(false);
});

it("retries a failed chunk download before giving up", async () => {
  let calls = 0;
  const value = await loadWithDownloadRetries(async () => {
    calls += 1;
    if (calls < 3) throw downloadError();
    return "loaded";
  }, [0, 0]);
  expect(value).toBe("loaded");
  expect(calls).toBe(3);

  calls = 0;
  await expect(
    loadWithDownloadRetries(async () => {
      calls += 1;
      throw downloadError();
    }, [0]),
  ).rejects.toThrow("Failed to fetch dynamically imported module");
  expect(calls).toBe(2);
});

it("does not retry other errors", async () => {
  let calls = 0;
  await expect(
    loadWithDownloadRetries(async () => {
      calls += 1;
      throw new Error("boom");
    }, [0, 0]),
  ).rejects.toThrow("boom");
  expect(calls).toBe(1);
});
