import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const MODELS = ["gpt-6-luna", "gpt-5.6-luna"];
const BUDGET_MS = 5_000;
const MAX_TITLE_COLUMNS = 48;
const ENDPOINTS = {
  chatgpt: "https://chatgpt.com/backend-api/codex/responses",
  apiKey: "https://api.openai.com/v1/responses",
};
const REQUEST = {
  instructions:
    "Follow the user prompt. Reply with only the requested text, " +
    "without quotes or commentary.",
  reasoning: { effort: "none" },
  store: false,
  stream: true,
};
const TITLE_PROMPT = `You create concise titles for coding tasks.
Reply with only the title: short, clear, sentence case, in the same language \
as the task. Keep it under about 40 characters; for scripts that do not \
separate words with spaces, that is roughly 20 characters. Summarize the task \
in your own words instead of copying its text. No quotes, no trailing \
punctuation, no explanation.

Consider the user's intent when titling to make it useful. For instance, if \
they detail specific tools to use to solve a problem, it is the problem that \
should be the title, not the tools that should be used.

Task:
`;
const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/giu;
const LABEL = /^(?:title|thread title)\s*:\s*/iu;
const WRAPPED = /^(?:(["'`]|\*\*?)(.*)\1|[“‘](.*)[”’])$/u;
const text = z.string();
const authSchema = z.object({
  auth_mode: text.nullish(),
  OPENAI_API_KEY: text.nullish(),
  tokens: z.object({ access_token: text, account_id: text }).nullish(),
});
const claimsSchema = z.object({ exp: z.number().optional() });
const eventSchema = z.object({ type: text, delta: text.optional() });

function parse<T>(schema: z.ZodType<T>, json: string) {
  try {
    return schema.parse(JSON.parse(json));
  } catch {
    return undefined;
  }
}

async function credential(urls: typeof ENDPOINTS, codexHome: string) {
  const file = await readFile(join(codexHome, "auth.json"), "utf8");
  const auth = parse(authSchema, file);
  const apiKey = auth?.OPENAI_API_KEY || null;
  const mode = auth?.auth_mode?.toLowerCase() ?? "apikey";
  if (apiKey !== null && mode === "apikey") {
    return { url: urls.apiKey, token: apiKey, extra: {} };
  }
  if (auth?.tokens == null) return null;
  const { access_token: token, account_id: accountId } = auth.tokens;
  const payload = Buffer.from(token.split(".")[1] ?? "", "base64url");
  const expiry = parse(claimsSchema, payload.toString())?.exp ?? Infinity;
  if (Date.now() >= expiry * 1000) return null;
  const account = { "chatgpt-account-id": accountId, originator: "bb" };
  const extra = { ...account, "OpenAI-Beta": "responses=experimental" };
  return { url: urls.chatgpt, token, extra };
}

async function outputText(response: Response) {
  if (response.status === 429 || response.status >= 500) return null;
  if (!response.ok) throw new Error(`Codex title: HTTP ${response.status}`);
  let reply = "";
  for (const line of (await response.text()).split("\n")) {
    const event = line.startsWith("data:") && parse(eventSchema, line.slice(5));
    if (!event) continue;
    if (event.type === "error" || event.type === "response.failed") return null;
    if (event.type === "response.output_text.delta") reply += event.delta ?? "";
  }
  return reply || null;
}

function unwrap(text: string): string {
  const found = WRAPPED.exec(text);
  return found === null ? text : unwrap((found[2] ?? found[3] ?? "").trim());
}

export function cleanTitle(reply: string): string | null {
  for (const line of reply.replace(THINK_BLOCK, "").split(/\r?\n/u)) {
    const bare = unwrap(line.trim().replace(/^[-*]\s+/u, ""));
    const title = unwrap(bare.replace(LABEL, "")).replace(/\s+/gu, " ");
    if (/^$|^```|:$/u.test(title)) continue;
    if (title.length <= MAX_TITLE_COLUMNS) return title;
    const space = title.lastIndexOf(" ", MAX_TITLE_COLUMNS);
    return title.slice(0, space > 0 ? space : MAX_TITLE_COLUMNS).trim();
  }
  return null;
}

export async function codexTitle(
  task: string,
  caller: AbortSignal,
  urls = ENDPOINTS,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(BUDGET_MS)]);
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const target = await credential(urls, home).catch(() => null);
  if (target === null) return null;
  const headers = {
    ...target.extra,
    Authorization: `Bearer ${target.token}`,
    "User-Agent": "bb-host-daemon",
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  const content = [{ type: "input_text", text: TITLE_PROMPT + task }];
  const input = [{ role: "user", content }];
  for (const model of MODELS) {
    const body = JSON.stringify({ ...REQUEST, model, input });
    const init = { method: "POST", headers, body, signal };
    const reply = await outputText(await fetch(target.url, init));
    if (reply !== null) return cleanTitle(reply);
  }
  return null;
}
