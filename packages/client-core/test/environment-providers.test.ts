import { expect, it } from "vitest";
import { defaultEnvironmentProvider } from "../src/environment-providers.js";

const kind = (
  id: string,
  workspace: string,
  rank: number | undefined,
  projectless = false,
) => ({
  id,
  workspace,
  ...(rank === undefined ? {} : { default: rank }),
  requires: { projectless },
});

it("picks the highest-default kind that declares what is wanted", () => {
  const providers = [
    kind("checkout", "unmanaged", 1),
    kind("worktree", "managed-worktree", 2),
    kind("sandbox", "unmanaged", undefined),
    kind("cow", "managed-worktree", 5),
    kind("home", "personal", 1, true),
  ];
  const pick = (want: Parameters<typeof defaultEnvironmentProvider>[1]) =>
    defaultEnvironmentProvider(providers, want)?.id;
  expect(pick({ workspace: "managed-worktree" })).toBe("cow");
  expect(pick({ workspace: "unmanaged" })).toBe("checkout");
  expect(pick({ projectless: true })).toBe("home");
  expect(pick({ projectless: false })).toBe("cow");
  expect(defaultEnvironmentProvider([], { projectless: false })).toBe(
    undefined,
  );
});
