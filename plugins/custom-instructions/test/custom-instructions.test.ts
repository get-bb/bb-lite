import { sessions } from "@bb/plugin";
import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";

interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

it("sets, prints and clears instructions with --json and a length cap", async () => {
  const server = await createThreadServer();
  const context = {
    threadId: await server.spawn(),
    projectId: "proj_1",
    hostId: "host_1",
    providerId: "codex",
  };
  const cli = async (argv: string[]) => {
    const url = `${server.url}/api/v1/plugins/custom-instructions/cli`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv }),
    });
    return JSON.parse((await response.text()).trim()) as CliOutput;
  };
  const injected = async () =>
    (await server.ctx.kernel.call(sessions.instructions, context))
      .filter(({ source }) => source === "custom-instructions")
      .map(({ text }) => text);
  const set = await cli(["set", "use", "tabs", "--json"]);
  expect(JSON.parse(set.stdout)).toEqual({ instructions: "use tabs" });
  expect(await injected()).toEqual(["use tabs"]);
  expect((await cli(["get"])).stdout).toBe("use tabs");
  expect(JSON.parse((await cli(["get", "--json"])).stdout)).toEqual({
    instructions: "use tabs",
  });
  const long = await cli(["set", "x".repeat(4097)]);
  expect(long.exitCode).not.toBe(0);
  expect(long.stderr).toContain("at most 4096 characters");
  expect((await cli(["get"])).stdout).toBe("use tabs");
  expect(JSON.parse((await cli(["clear", "--json"])).stdout)).toEqual({
    instructions: "",
  });
  expect(await injected()).toEqual([]);
});
