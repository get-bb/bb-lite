import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type PluginServerApi,
} from "@bb/plugin";
import { z } from "zod";

const MIGRATIONS = ["CREATE TABLE calls (text TEXT NOT NULL)"];

const contract = defineRpcContract({
  echo: {
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string(), calls: z.number() }),
  },
  fail: { input: z.null(), output: z.null() },
});

const say = cliCommand({
  summary: "Repeat a phrase",
  positionals: [{ name: "text", description: "Phrase", required: true }],
  options: {
    times: { type: "integer", description: "Repetitions", default: 1 },
    tone: { type: "enum", values: ["plain", "loud"], description: "Tone" },
    json: { type: "boolean", description: "Emit JSON" },
  },
  run({ positionals: { text }, options }, { threadId }) {
    if (text === "nothing") {
      throw new PluginCliError("Nothing to say", { exitCode: 3 });
    }
    const phrase = Array<string>(options.times).fill(text).join(" ");
    const said = options.tone === "loud" ? phrase.toUpperCase() : phrase;
    const stdout = options.json ? JSON.stringify({ said, threadId }) : said;
    return { exitCode: 0, stdout };
  },
});

export default async function echoPlugin(bb: PluginServerApi) {
  const settings = bb.settings.define({
    greeting: { type: "string", label: "Greeting", default: "hello" },
    apiKey: { type: "string", label: "API key", secret: true },
  });
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
  const countCalls = database.prepare("SELECT count(*) FROM calls").pluck();

  bb.rpc.register(contract, {
    async echo({ text }) {
      const { greeting } = await settings.get();
      database.prepare("INSERT INTO calls VALUES (?)").run(text);
      await bb.storage.kv.set("last", text);
      bb.realtime.publish("echoed", { text });
      return { text: `${greeting} ${text}`, calls: Number(countCalls.get()) };
    },
    fail() {
      throw new Error("boom");
    },
  });
  for (const auth of ["local", "token", "none"] as const) {
    bb.http.route("GET", `/${auth}`, () => Response.json({ auth }), { auth });
  }
  const commands = { say };
  bb.cli.register(
    defineCli({ name: "echo", summary: "Echo phrases", commands }),
  );
  bb.background.service("ticker", {
    async start() {
      const starts = ((await bb.storage.kv.get<number>("starts")) ?? 0) + 1;
      await bb.storage.kv.set("starts", starts);
      if (starts === 1) throw new Error("first start fails");
    },
  });
  bb.onDispose(() => bb.storage.kv.set("disposed", true));
}
