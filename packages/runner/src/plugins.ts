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
  type PluginScope,
  type PluginVerbs,
  type Tier,
} from "@bb/plugin";
import type { ProviderAdapter } from "./providers/provider.js";
import {
  RunnerError,
  type LoadPluginsResult,
  type RunnerPartBundle,
} from "./types.js";

export const RUNNER_RUNTIME_GLOBAL = "__bbRunnerRuntime";
export const RUNNER_SHARED_MODULES = ["@bb/runner", "@bb/plugin"] as const;

export const runner = contract("runner", {
  provider: slot<ProviderAdapter>({ key: "id" }),
});

export interface PluginRunnerApi extends PluginVerbs {
  readonly pluginId: string;
  readonly dataDir: string;
  log(message: string): void;
}

export type RunnerPluginEntry = (bb: PluginRunnerApi) => void | Promise<void>;

export interface RunnerPart {
  id: string;
  entry: RunnerPluginEntry;
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

  const start = async (part: RunnerPart): Promise<void> => {
    scopes.get(part.id)?.dispose();
    const scope = kernel.scope(part.id, part.tier ?? "product");
    scopes.set(part.id, scope);
    const { dispose, ...verbs } = scope;
    const dataDir = join(options.dataDir, "plugins", part.id);
    const api: PluginRunnerApi = {
      ...verbs,
      pluginId: part.id,
      dataDir,
      log: (message) => log(`[${part.id}] ${message}`),
    };
    try {
      await part.entry(api);
    } catch (error) {
      dispose();
      scopes.delete(part.id);
      throw error;
    }
  };

  const unload = (id: string) => {
    scopes.get(id)?.dispose();
    scopes.delete(id);
    shipped.delete(id);
  };

  return {
    kernel,
    load(part) {
      start(part).catch((error: unknown) => {
        log(`[${part.id}] runner part failed to load: ${messageOf(error)}`);
      });
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
          const entry = module.default as RunnerPluginEntry;
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
