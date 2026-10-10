import { sessions } from "@bb/plugin";
import { expect, it } from "vitest";
import * as helpers from "./helpers.js";

const env = "/environments/env_demo";

it("infers a commit message for pending changes and commits with it", async () => {
  const { server, repo, read, send } = await helpers.createDemo();
  const plugin = server.ctx.kernel.scope("fake-ai", "installed");
  expect(await read(`${env}/commit-message`)).toEqual({ message: null });
  helpers.write(repo, { "src/a.ts": "export const a = 2;\n" });
  const prompts: string[] = [];
  const remove = plugin.add(sessions.inference, {
    id: "fake",
    displayName: "Fake",
    complete: async (prompt) => {
      prompts.push(prompt);
      return '"feat: bump a to two"\nmore';
    },
  });
  expect(await read(`${env}/commit-message`)).toEqual({
    message: "feat: bump a to two",
  });
  expect(prompts[0]).toContain("src/a.ts");
  remove();
  const requests: unknown[] = [];
  plugin.add(sessions.completion, {
    complete: async (request) => {
      requests.push(request);
      return { text: "fix: set a to two" };
    },
  });
  const committed = await send(`${env}/actions`, { action: "commit" });
  expect(await committed.json()).toMatchObject({
    commitSubject: "fix: set a to two",
  });
  expect(requests).toMatchObject([{ maxTokens: 100 }]);
});

it("transcribes audio with the first available transcriber", async () => {
  const server = await helpers.createTestServer();
  const audio = { data: Buffer.from("voice").toString("base64") };
  const post = () =>
    server.send("/sessions/transcriptions", {
      ...audio,
      mimeType: "audio/webm",
    });
  const config = async () =>
    (
      await server.read<{ voiceTranscriptionEnabled?: boolean }>(
        "/server/config",
      )
    ).voiceTranscriptionEnabled;
  expect((await post()).status).toBe(501);
  expect(await config()).toBe(false);
  let ready = false;
  const heard: string[] = [];
  const plugin = server.ctx.kernel.scope("fake-voice", "installed");
  plugin.add(sessions.transcription, {
    id: "fake",
    label: "Fake",
    available: () => ready,
    transcribe: async ({ data, mimeType }) => {
      heard.push(`${Buffer.from(data).toString()} ${mimeType}`);
      return { text: "hello there" };
    },
  });
  expect(await config()).toBe(false);
  ready = true;
  expect(await config()).toBe(true);
  expect(await (await post()).json()).toEqual({ text: "hello there" });
  expect(heard).toEqual(["voice audio/webm"]);
});
