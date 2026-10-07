import type { PluginServerEntry } from "@bb/plugin";
import { z } from "zod";

const contract = {
  add: { input: z.object({ a: z.number(), b: z.number() }), output: z.number() },
  fail: { input: z.object({}), output: z.null() },
  wrong: { input: z.object({}), output: z.string() },
};

const plugin: PluginServerEntry = async (bb) => {
  const journal: string[] = [];
  const settings = bb.settings.define({
    greeting: { type: "string", label: "Greeting", default: "hi" },
  });
  settings.onChange((next, previous) => {
    journal.push(`settings ${previous.greeting}->${next.greeting}`);
  });
  bb.rpc.register(contract, {
    add: ({ a, b }) => a + b,
    fail: () => {
      throw new Error("boom");
    },
    wrong: () => 42 as unknown as string,
  });
  bb.rpc.register(
    { journal: { input: z.object({}), output: z.array(z.string()) } },
    { journal: () => journal },
  );
  bb.rpc.register(
    { storage: { input: z.object({}), output: z.unknown() } },
    {
      storage: async () => {
        await bb.storage.kv.set("a/1", { n: 1 });
        await bb.storage.kv.set("b/1", 2);
        const db = bb.storage.database();
        bb.storage.migrate(db, ["CREATE TABLE t (v TEXT)", "INSERT INTO t VALUES ('x')"]);
        bb.storage.migrate(db, ["CREATE TABLE t (v TEXT)", "INSERT INTO t VALUES ('x')"]);
        let changed = "";
        try {
          bb.storage.migrate(db, ["CREATE TABLE t (v INTEGER)"]);
        } catch (error) {
          changed = (error as Error).message;
        }
        return {
          kv: await bb.storage.kv.get("a/1"),
          missing: (await bb.storage.kv.get("zzz")) === undefined,
          keys: await bb.storage.kv.list("a/"),
          rows: db.prepare("SELECT v FROM t").all(),
          journal: db.pragma("journal_mode", { simple: true }),
          changed,
          settings: await settings.get(),
          updated: await settings.set({ greeting: "hello" }),
        };
      },
    },
  );
  bb.rpc.register(
    { outward: { input: z.object({}), output: z.unknown() } },
    {
      outward: async () => {
        const answer = await bb.ui.requestInput({
          threadId: "t1",
          rendererId: "r",
          title: "Pick",
          payload: { q: 1 },
          timeoutMs: 1000,
          signal: new AbortController().signal,
          describeSubmission: (value) => ({ described: value }),
        });
        return {
          answer,
          thread: await bb.threads.get("t1"),
          file: await bb.files.read({ threadId: "t1", path: "a.txt" }),
          projects: await bb.projects.list(),
        };
      },
    },
  );
  bb.http.route("POST", "/echo", async (request) => {
    const body = await request.text();
    return new Response(`${request.method} ${new URL(request.url).pathname} ${body}`, {
      status: 201,
      headers: { "x-plugin": bb.pluginId },
    });
  });
  bb.cli.register({
    name: "fixture",
    summary: "Fixture commands",
    commands: [{ name: "echo", summary: "Echo" }],
    run: (argv, context) => ({ exitCode: 0, stdout: `${argv.join(" ")} ${context.threadId}`, stderr: "" }),
  });
  bb.agents.registerTool({
    name: "shout",
    description: "Shouts",
    instructions: "Use it loudly",
    parameters: z.object({ text: z.string() }),
    enabledFor: (context) => context.providerId !== "hidden",
    execute: ({ text }, context) => `${text.toUpperCase()} in ${context.threadId}`,
  });
  bb.agents.contributeInstructions((context) => `Instructions for ${context.threadId}`);
  bb.providers.contributeEnv("codex", () => [{ name: "FIXTURE", value: "1" }]);
  bb.events.on("thread.created", (payload) => {
    journal.push(`created ${(payload as { thread: { id: string } }).thread.id}`);
  });
  bb.ui.registerMentionProvider({
    id: "docs",
    label: "Docs",
    search: (query) => [{ id: `doc-${query.query}`, title: "Doc" }],
    resolve: (itemId) => ({ context: `content of ${itemId}` }),
  });
  bb.background.service("ticker", {
    start: (signal) =>
      new Promise<void>((resolve) => {
        journal.push("service started");
        signal.addEventListener("abort", () => {
          void bb.storage.kv.set("service", "aborted").then(() => resolve());
        });
      }),
  });
  bb.inference.register({ id: "echo", displayName: "Echo", complete: async (prompt) => `<${prompt}>` });
  bb.environments.register({
    id: "fixture-env",
    displayName: "Fixture",
    create: async () => ({ path: "/tmp/x" }),
    remove: async () => {},
  });
  bb.status.needsConfiguration("configure me");
  bb.server.setPublicUrl(`${bb.server.url}/public`);
  bb.realtime.publish("ch", { n: 1 });
  bb.log.info(`started in ${bb.dataDir}`);
  bb.onDispose(async () => {
    const seen = ((await bb.storage.kv.get("disposed")) as string[] | undefined) ?? [];
    await bb.storage.kv.set("disposed", [...seen, "first"]);
  });
  bb.onDispose(async () => {
    const seen = ((await bb.storage.kv.get("disposed")) as string[] | undefined) ?? [];
    await bb.storage.kv.set("disposed", [...seen, "second"]);
  });
};

export default plugin;
