import { createHash } from "node:crypto";

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _bb_migrations
  (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)`;

let nextHandler = 0;
const controllers = new Map();
const signals = new Map();

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
const withoutNulls = (record) =>
  Object.fromEntries(Object.entries(record ?? {}).filter(([, value]) => value != null));

const handler = (fn) => {
  const id = `plugin:${++nextHandler}`;
  __bb.handle(id, fn);
  return id;
};

const register = (kind, meta) => __bb.op("plugin.register", { kind, ...meta });

const call = (method, ...args) => __bb.opAsync("plugin.outward", { method, args });

__bb.handle("plugin:abort", (key) => {
  controllers.get(key)?.abort();
  controllers.delete(key);
  return null;
});

const signalFor = (key) => {
  const controller = new AbortController();
  controllers.set(key, controller);
  return controller.signal;
};

const withSignal = async (key, run) => {
  try {
    return await run(signalFor(key));
  } finally {
    controllers.delete(key);
  }
};

const rustSignal = (signal) => {
  if (signal === undefined || signal === null) return null;
  const key = __bb.op("plugin.signal", null);
  signals.set(key, signal);
  if (signal.aborted) __bb.op("plugin.abort", key);
  else signal.addEventListener("abort", () => __bb.op("plugin.abort", key), { once: true });
  return key;
};

const issueList = (error) =>
  error.issues.map(({ message, path }) => ({
    message,
    path: path.map((part) => (typeof part === "symbol" ? String(part) : part)),
  }));

const rpcError = (code, error) => {
  if (typeof error === "string") return { ok: false, error: { code, message: error } };
  const issues = issueList(error);
  return { ok: false, error: { code, message: issues[0]?.message ?? code, issues } };
};

function migrate(database, statements) {
  database.exec(MIGRATIONS_TABLE);
  const applied = database.prepare("SELECT statement_hash FROM _bb_migrations ORDER BY id").all();
  const record = database.prepare("INSERT INTO _bb_migrations VALUES (?, ?, ?)");
  database.transaction(() => {
    statements.forEach((statement, index) => {
      const hash = createHash("sha256").update(statement).digest("hex");
      const recorded = applied[index];
      if (recorded === undefined) {
        database.exec(statement);
        record.run(index, Date.now(), hash);
      } else if ((recorded.statement_hash ?? hash) !== hash) {
        throw new Error(`Migration ${index} changed after it was applied; append a new one`);
      }
    });
  })();
}

function createApi(config, z) {
  let database;
  const at = (level) => (message) => __bb.op("plugin.log", { level, message: String(message) });
  const settingsHandle = (handle) => ({
    get: () => call("settings.get", handle),
    set: (values) => call("settings.set", handle, values),
    onChange(listener) {
      const id = handler(({ next, previous }) => listener(next, previous));
      register("settings.onChange", { handle, handler: id });
    },
  });
  const describeTool = (tool) => {
    const execute = handler(({ input, context, signal }) =>
      withSignal(signal, async (abort) => {
        const parsed = await tool.parameters.safeParseAsync(input);
        if (!parsed.success) return { invalid: parsed.error.message };
        try {
          const result = await tool.execute(parsed.data, { ...context, signal: abort });
          return typeof result === "string"
            ? { text: result, isError: false, plain: true }
            : { text: result.text, isError: !!result.isError };
        } catch (error) {
          return { failed: errorMessage(error) };
        }
      }),
    );
    return {
      name: tool.name,
      description: tool.description,
      instructions: tool.instructions ?? null,
      presentation: tool.presentation ?? null,
      inputSchema: z.toJSONSchema(tool.parameters),
      enabledFor: tool.enabledFor ? handler((context) => !!tool.enabledFor(context)) : null,
      execute,
    };
  };
  const api = {
    threads: {
      spawn: (request) => call("threads.spawn", request),
      send: (threadId, request) => call("threads.send", threadId, request),
      get: (threadId) => call("threads.get", threadId),
      list: (query) => call("threads.list", query ?? {}),
      stop: (threadId) => call("threads.stop", threadId),
      update: (threadId, patch) => call("threads.update", threadId, patch),
      output: (threadId) => call("threads.output", threadId),
      events: (threadId, afterSequence) => call("threads.events", threadId, afterSequence ?? null),
    },
    projects: { list: () => call("projects.list") },
    hosts: { list: () => call("hosts.list") },
    sections: {
      list: () => call("sections.list"),
      create: (name) => call("sections.create", name),
    },
    files: {
      read: (args) => call("files.read", args),
      write: (args) => call("files.write", args),
    },
    pluginId: config.pluginId,
    log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    dataDir: config.dataDir,
    settings: {
      define: (descriptors) => settingsHandle(register("settings.define", { descriptors })),
    },
    storage: {
      kv: {
        get: async (key) => (await call("kv.get", key)) ?? undefined,
        set: (key, value) => call("kv.set", key, value === undefined ? null : JSON.stringify(value)),
        delete: (key) => call("kv.delete", key),
        list: (prefix) => call("kv.list", prefix ?? null),
      },
      database() {
        if (database?.open) return database;
        const opened = __bb.openDatabase(register("database", {}));
        opened.pragma("journal_mode = WAL");
        opened.pragma("busy_timeout = 5000");
        database = opened;
        return opened;
      },
      migrate,
    },
    rpc: {
      register(contract, handlers) {
        for (const [method, methodContract] of Object.entries(contract)) {
          const run = handlers[method];
          const id = handler(async (input) => {
            const accepted = await methodContract.input.safeParseAsync(input);
            if (!accepted.success) return rpcError("invalid_input", accepted.error);
            let result;
            try {
              result = await run(accepted.data);
            } catch (error) {
              return rpcError("handler_error", errorMessage(error));
            }
            const produced = await methodContract.output.safeParseAsync(result);
            if (!produced.success) return rpcError("invalid_output", produced.error);
            return { ok: true, value: produced.data ?? null };
          });
          register("rpc", { method, handler: id });
        }
      },
    },
    http: {
      route(method, path, run, { auth = "local" } = {}) {
        const id = handler(async (request) =>
          __bb.responseToJson(await run(__bb.requestFromJson(request))),
        );
        register("http", { method, path, auth, handler: id });
      },
    },
    realtime: {
      publish: (channel, payload) => __bb.op("plugin.publish", { channel, payload: payload ?? null }),
    },
    background: {
      service(name, service) {
        const id = handler(({ signal }) => withSignal(signal, async (abort) => {
          await service.start(abort);
          return null;
        }));
        register("service", { name, handler: id });
      },
    },
    cli: {
      register(registration) {
        const run = handler(({ argv, context, signal }) =>
          withSignal(signal, (abort) =>
            // Absent fields are `undefined` in the Node server (`cli.threadId === undefined`).
            registration.run(argv, { ...withoutNulls(context), signal: abort })),
        );
        register("cli", {
          name: registration.name,
          summary: registration.summary,
          commands: registration.commands ?? [],
          handler: run,
        });
      },
    },
    events: {
      on(name, run) {
        register("event", { name, handler: handler(async (payload) => { await run(payload); return null; }) });
      },
    },
    agents: {
      registerTool: (tool) => register("tool", describeTool(tool)),
      contributeInstructions(contribute) {
        register("instructions", { handler: handler(async (context) => (await contribute(context)) ?? null) });
      },
    },
    ui: {
      requestInput({ signal, describeSubmission, ...request }) {
        return call("ui.requestInput", {
          ...request,
          signal: rustSignal(signal),
          describeSubmission: describeSubmission
            ? handler(async (value) => (await describeSubmission(value)) ?? null)
            : null,
        });
      },
      registerMentionProvider(provider) {
        register("mention", {
          id: provider.id,
          label: provider.label,
          triggers: provider.triggers ? [...provider.triggers] : null,
          search: handler(async (query) => [...(await provider.search(query))]),
          resolve: handler(async (itemId) => (await provider.resolve(itemId)).context),
        });
      },
    },
    providers: {
      contributeEnv(providerId, contribute) {
        register("env", { providerId, handler: handler(async (context) => (await contribute(context)) ?? []) });
      },
    },
    environments: {
      register(definition) {
        register("environment", {
          id: definition.id,
          displayName: definition.displayName,
          icon: definition.icon ?? null,
          create: handler(({ context, signal }) =>
            withSignal(signal, (abort) => definition.create({ ...context, signal: abort })),
          ),
          remove: handler(async (context) => { await definition.remove(context); return null; }),
        });
      },
    },
    inference: {
      register(service) {
        register("inference", {
          id: service.id,
          displayName: service.displayName,
          handler: handler(({ prompt, signal }) =>
            withSignal(signal, (abort) => service.complete(prompt, { signal: abort })),
          ),
        });
      },
    },
    status: {
      needsConfiguration: (message) => { register("needsConfiguration", { message: String(message) }); },
    },
    machines: {
      setAccessProvider(provider) {
        register("machineAccess", provider ? {
          grant: handler(async (hostId) => (await provider.grant(hostId)) ?? null),
          revoke: handler(async (host) => { await provider.revoke(host); return null; }),
        } : { grant: null, revoke: null });
      },
    },
    server: {
      url: config.serverUrl,
      dataDir: config.serverDataDir,
      setPublicUrl: (url) => { register("publicUrl", { url: url ?? null }); },
    },
    onDispose(dispose) {
      register("dispose", { handler: handler(async () => { await dispose(); return null; }) });
    },
  };
  return api;
}

export async function start(entry, z, config) {
  const api = createApi(config, z);
  await entry(api);
  return null;
}
