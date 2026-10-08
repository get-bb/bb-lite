import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  contract,
  createKernel,
  slot,
  type Caller,
  type Kernel,
  type PluginBase,
  type PluginScope,
  type Tier,
} from "@bb/plugin";
import type { ProviderAdapter } from "./providers/provider.js";
import {
  type RunnerEventSink,
  RunnerError,
  type LoadPluginsResult,
  type RunnerPartBundle,
} from "./types.js";

export const RUNNER_RUNTIME_GLOBAL = "__bbRunnerRuntime";
export const RUNNER_SHARED_MODULES = ["@bb/runner", "@bb/plugin"] as const;

export const runner = contract("runner", {
  provider: slot<ProviderAdapter>({ key: "id" }),
});

export interface PluginRunnerApi extends PluginBase {
  readonly dataDir: string;
  signal(name: string, payload?: unknown): void;
}

export type PluginRunnerEntry = (bb: PluginRunnerApi) => void | Promise<void>;

export interface RunnerPart {
  id: string;
  entry: PluginRunnerEntry;
  tier?: Tier;
}

export interface RunnerPlugins {
  kernel: Kernel;
  load(part: RunnerPart): void;
  sync(bundles: RunnerPartBundle[]): Promise<LoadPluginsResult>;
  adapters(): ProviderAdapter[];
  callOp(name: string, input: unknown): Promise<unknown>;
  dispose(): void;
}

const SYSTEM: Caller = {
  user: null,
  role: "system",
  door: "system",
  thread: null,
  via: [],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRunnerPlugins(options: {
  dataDir: string;
  log?: (message: string) => void;
  sink?: RunnerEventSink;
}): RunnerPlugins {
  const log = options.log ?? (() => {});
  let caller = SYSTEM;
  const kernel = createKernel({
    currentCaller: () => caller,
    enter(next, work) {
      const previous = caller;
      caller = next;
      try {
        return work();
      } finally {
        caller = previous;
      }
    },
    record: () => {},
    now: Date.now,
    warn: (message, fields) => log(`${message} ${JSON.stringify(fields)}`),
  });
  const scopes = new Map<string, PluginScope>();
  const shipped = new Map<string, string>();
  const builtin = new Map<string, RunnerPart>();

  const start = async (part: RunnerPart): Promise<void> => {
    scopes.get(part.id)?.dispose();
    const scope = kernel.scope(part.id, part.tier ?? "product");
    scopes.set(part.id, scope);
    const { dispose, ...verbs } = scope;
    const dataDir = join(options.dataDir, "plugins", part.id);
    const say = (level: string) => (message: string, fields?: object) => {
      const detail = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
      log(`[${part.id}] ${level}: ${message}${detail}`);
    };
    const starters: Parameters<PluginBase["onStart"]>[0][] = [];
    const stops: (() => unknown)[] = [];
    const api: PluginRunnerApi = {
      ...verbs,
      pluginId: part.id,
      dataDir,
      log: {
        debug: say("debug"),
        info: say("info"),
        warn: say("warn"),
        error: say("error"),
      },
      signal(name, payload = null) {
        const signal = { kind: "plugin.signal", pluginId: part.id } as const;
        options.sink?.({ lane: "live", ...signal, name, payload });
      },
      onStart: (start) => void starters.push(start),
      onDispose: (stop) => void stops.push(stop),
    };
    const stop = () => {
      for (const run of stops.splice(0).reverse()) {
        Promise.resolve()
          .then(run)
          .catch((error: unknown) => failed(part.id)(error));
      }
      dispose();
    };
    scopes.set(part.id, { ...scope, dispose: stop });
    try {
      await part.entry(api);
      for (const start of starters) {
        const stopping = await start();
        if (typeof stopping === "function") stops.push(stopping);
      }
    } catch (error) {
      stop();
      scopes.delete(part.id);
      throw error;
    }
  };

  const failed = (id: string) => (error: unknown) => {
    log(`[${id}] runner part failed to load: ${messageOf(error)}`);
  };

  const unload = (id: string) => {
    scopes.get(id)?.dispose();
    scopes.delete(id);
    shipped.delete(id);
    const original = builtin.get(id);
    if (original !== undefined) start(original).catch(failed(id));
  };

  return {
    kernel,
    load(part) {
      builtin.set(part.id, part);
      start(part).catch(failed(part.id));
    },
    async sync(bundles) {
      const result: LoadPluginsResult = { loaded: [], failed: [] };
      const wanted = new Set(bundles.map(({ id }) => id));
      for (const id of [...shipped.keys()]) {
        if (!wanted.has(id)) unload(id);
      }
      for (const { id, hash, code } of bundles) {
        if (shipped.get(id) === hash) {
          result.loaded.push(id);
          continue;
        }
        try {
          const shared = {
            "@bb/runner": await import("./index.js"),
            "@bb/plugin": await import("@bb/plugin"),
          };
          Object.assign(globalThis, { [RUNNER_RUNTIME_GLOBAL]: shared });
          const digest = createHash("sha256").update(code).digest("hex");
          if (digest !== hash) throw new Error("the bundle does not match");
          const directory = join(options.dataDir, "plugins", id, ".cache");
          await mkdir(directory, { recursive: true });
          const file = join(directory, `runner.${hash.slice(0, 16)}.mjs`);
          await writeFile(file, code);
          const module = (await import(pathToFileURL(file).href)) as {
            default?: unknown;
          };
          if (typeof module.default !== "function") {
            throw new Error("the runner part has no default export");
          }
          const entry = module.default as PluginRunnerEntry;
          await start({ id, entry, tier: "installed" });
          shipped.set(id, hash);
          result.loaded.push(id);
        } catch (error) {
          unload(id);
          result.failed.push({ id, message: messageOf(error) });
        }
      }
      return result;
    },
    adapters: () => kernel.read(runner.provider),
    async callOp(name, input) {
      const op = kernel.op(name);
      if (op === null) {
        const message = `No runner part implements "${name}" on this machine`;
        throw new RunnerError("unavailable", message);
      }
      return kernel.call(op, input);
    },
    dispose() {
      for (const scope of scopes.values()) scope.dispose();
      scopes.clear();
      shipped.clear();
    },
  };
}
