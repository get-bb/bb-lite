import { createRunnerPlugins } from "@bb/runner";
import { expect, it, onTestFinished } from "vitest";
import { scratch } from "../../../apps/server/test/helpers.js";
import { createGithubRunner, type Exec } from "../runner.js";

it("runs gh and git in the checkout through the injected command runner", async () => {
  const ran: { command: string; args: string[]; cwd?: string }[] = [];
  const exec: Exec = async (command, args, { cwd }) => {
    ran.push({ command, args, cwd });
    if (command === "git") throw new Error("fatal: not a git repository");
    return "{}";
  };
  const runners = createRunnerPlugins({ dataDir: scratch(), sink: () => {} });
  onTestFinished(() => runners.dispose());
  runners.load({ id: "github", entry: createGithubRunner(exec) });

  expect(
    await runners.callOp("github.exec", {
      command: "gh",
      args: ["pr", "view", "--json", "url"],
      cwd: "/work",
    }),
  ).toEqual({ stdout: "{}" });
  expect(ran[0]).toMatchObject({
    args: ["pr", "view", "--json", "url"],
    cwd: "/work",
  });
  expect(ran[0]?.command).toMatch(/gh$/);
  await expect(
    runners.callOp("github.exec", { command: "git", args: ["status"] }),
  ).rejects.toThrow(/not a git repository/);
});
