import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { expect, onTestFinished, test } from "vitest";
import { cleanTitle, codexTitle } from "../src/providers/title-service.js";
import { scratch } from "./helpers.js";

const part = (delta: string): string =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`;
const STREAM = `${part('Title: "Fix the flaky')}${part(' test"')}data: [DONE]`;

test("titles come from the Codex login and survive a rate limit", async () => {
  const seen: unknown[][] = [];
  const endpoint = createServer(async (request, response) => {
    const { model } = JSON.parse(await text(request)) as { model: string };
    const { authorization, "chatgpt-account-id": account } = request.headers;
    seen.push([request.url, model, authorization, account]);
    response.writeHead(seen.length === 1 ? 429 : 200).end(STREAM);
  });
  await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
  onTestFinished(() => void endpoint.close());
  const { port } = endpoint.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const urls = { chatgpt: `${base}/chatgpt`, apiKey: `${base}/key` };
  const env = { CODEX_HOME: scratch() };
  const login = (auth: object): void =>
    writeFileSync(join(env.CODEX_HOME, "auth.json"), JSON.stringify(auth));
  const signal = AbortSignal.timeout(2_000);
  const title = () => codexTitle("fix it", signal, urls, env);
  expect(await title()).toBeNull();
  const expired = Buffer.from('{"exp":1}').toString("base64url");
  login({ tokens: { access_token: `a.${expired}.c`, account_id: "acct" } });
  expect(await title()).toBeNull();
  expect(seen).toEqual([]);
  login({ tokens: { access_token: "a.e30.c", account_id: "acct" } });
  expect(await title()).toBe("Fix the flaky test");
  login({ OPENAI_API_KEY: "sk-test", tokens: null });
  expect(await title()).toBe("Fix the flaky test");
  expect(seen).toEqual([
    ["/chatgpt", "gpt-6-luna", "Bearer a.e30.c", "acct"],
    ["/chatgpt", "gpt-5.6-luna", "Bearer a.e30.c", "acct"],
    ["/key", "gpt-6-luna", "Bearer sk-test", undefined],
  ]);
  const wordy = `<think>hm</think>\n- **\`${"Tidy the queue ".repeat(5)}\`**`;
  const clamped = "Tidy the queue Tidy the queue Tidy the queue";
  expect(cleanTitle(wordy)).toBe(clamped);
  expect(cleanTitle("Here is the title:\n\n")).toBeNull();
});
