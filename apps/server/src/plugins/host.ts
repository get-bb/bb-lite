import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch as watchDirectory, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import type { Kernel } from "@bb/plugin";
import type { RunnerPartBundle } from "@bb/runner";
import type { InstalledPlugin, PluginApp } from "@bb/server-contract";
import { asSystem } from "../auth/actor.js";
import { dataPaths, loopbackUrl, type ServerConfig } from "../config.js";
import type { Logger } from "../context.js";
import type { Db } from "../db/index.js";
import { isPluginEnabled, setPluginEnabled } from "../db/plugins.js";
import type { ServerContext } from "../context.js";
import type { Disposer } from "../server.js";
import type { Hub } from "../ws/hub.js";
import { builtinPlugins, type BuiltinPlugin } from "./builtin.js";
import { bundleApp, bundleRunnerPart, importServerEntry } from "./bundle.js";
import { createPluginHostDeps, type PluginHostDeps } from "./deps.js";
import { errorMessage } from "../http/errors.js";
import { createPluginInstance } from "./instance.js";
import { readExternalPluginEntries, readManifest } from "./manifest.js";
import { PluginRegistry, type PluginRecord } from "./registry.js";

export interface PluginHostOptions {
  config: ServerConfig;
  db: Db;
  hub: Hub;
  log: Logger;
  tunnelToken: string;
  kernel: Kernel;
  builtins?: BuiltinPlugin[];
}

type PluginOrigin = Pick<
  PluginRecord,
  "server" | "external" | "configEnabled" | "watch"
>;

const WATCH_DEBOUNCE_MS = 200;
const UNWATCHED = /(^|[\\/])(node_modules|\.cache|\.git|\.bb|dist)([\\/]|$)/u;

const UNLOADED = { instance: null, app: null, error: null, token: null };

export class PluginHost extends PluginRegistry {
  deps: PluginHostDeps = () => {
    throw new Error("The plugin host has not started");
  };
  onChanged: () => void = () => {};
  private settled: Promise<void> = Promise.resolve();
  private readonly runnerBundles = new Map<string, RunnerPartBundle>();
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(private readonly options: PluginHostOptions) {
    super(options.log, options.kernel);
  }

  async reload(id?: string): Promise<void> {
    await this.discover();
    const targets =
      id === undefined ? this.inDependencyOrder() : [this.record(id)];
    for (const record of targets) await this.load(record);
    this.options.hub.system(["plugins-changed"]);
    this.onChanged();
  }

  async runnerParts(): Promise<RunnerPartBundle[]> {
    const bundles: RunnerPartBundle[] = [];
    for (const { manifest, instance, external } of this.records.values()) {
      const { id, runnerEntry } = manifest;
      if (instance === null || !external || runnerEntry === null) continue;
      try {
        const bundle = await bundleRunnerPart(id, runnerEntry);
        this.runnerBundles.set(id, bundle);
        bundles.push(bundle);
      } catch (error) {
        const fields = { pluginId: id, err: error };
        this.options.log.error("Plugin runner part failed to build", fields);
      }
    }
    return bundles;
  }

  stop(): Promise<void> {
    return this.inOrder(async () => {
      for (const watcher of this.watchers.values()) watcher.close();
      this.watchers.clear();
      for (const record of [...this.records.values()].reverse()) {
        await this.unload(record);
      }
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin> {
    const record = this.record(id);
    setPluginEnabled(this.options.db, id, enabled);
    await this.load(record);
    this.options.hub.system(["plugins-changed"]);
    this.onChanged();
    return this.describe(record);
  }

  list(): InstalledPlugin[] {
    return [...this.records.values()].map((record) => this.describe(record));
  }

  token(id: string, rotate: boolean): string {
    const record = this.record(id);
    if (record.token === null || rotate) {
      record.token = randomBytes(24).toString("base64url");
    }
    return record.token;
  }

  acceptsToken(id: string, presented = ""): boolean {
    const expected = Buffer.from(this.record(id).token ?? "");
    const given = Buffer.from(presented);
    const comparable = expected.length > 0 && expected.length === given.length;
    return comparable && timingSafeEqual(expected, given);
  }

  hasPersonalSettings(id: string, keys: readonly string[]): boolean {
    return this.running(id).settings.isPersonal(keys);
  }

  async settings(
    id: string,
    update?: Record<string, unknown>,
    userId: string | null = null,
  ) {
    const instance = this.running(id);
    if (update !== undefined) {
      await instance.settings.write(update, userId);
      const waiting = instance.needsConfiguration !== null;
      if (waiting) await this.load(this.record(id));
      this.options.hub.system(["plugins-changed"]);
    }
    const { settings } = this.running(id);
    const values = await settings.publicValues(userId);
    return { schema: settings.descriptors, values };
  }

  private inDependencyOrder(): PluginRecord[] {
    const ordered: PluginRecord[] = [];
    const visit = (record: PluginRecord, trail: string[]) => {
      if (ordered.includes(record) || trail.includes(record.manifest.id)) {
        return;
      }
      for (const required of record.manifest.requires) {
        const needed = this.records.get(required);
        const deeper = [...trail, record.manifest.id];
        if (needed !== undefined) visit(needed, deeper);
      }
      ordered.push(record);
    };
    for (const record of this.records.values()) visit(record, []);
    return ordered;
  }

  private inOrder(work: () => Promise<void>): Promise<void> {
    const done = this.settled.then(work);
    this.settled = done.catch(() => {});
    return done;
  }

  private isEnabled(record: PluginRecord): boolean {
    const { id } = record.manifest;
    return record.configEnabled && isPluginEnabled(this.options.db, id);
  }

  private describe(record: PluginRecord): InstalledPlugin {
    const { manifest, instance, error } = record;
    const { id, name, description, icon } = manifest;
    const base = `/api/v1/plugins/${id}`;
    const enabled = this.isEnabled(record);
    const disabledBy = record.configEnabled ? null : "Disabled in config.json";
    const waiting = instance?.needsConfiguration ?? null;
    const settings = instance?.settings.descriptors ?? {};
    const cli = this.cliOf(id);
    const loaded = waiting === null ? "running" : "needs-configuration";
    return {
      id,
      name,
      description,
      icon: icon?.startsWith("./") ? `${base}/assets/${icon.slice(2)}` : icon,
      enabled,
      status: !enabled ? "disabled" : instance === null ? "error" : loaded,
      statusMessage: enabled ? (error ?? waiting) : disabledBy,
      hasSettings: Object.keys(settings).length > 0,
      settings,
      app: this.describeApp(record, base),
      cliCommands:
        cli === null ? [] : [{ name: cli.name, summary: cli.summary }],
    };
  }

  private describeApp(record: PluginRecord, base: string): PluginApp | null {
    if (record.manifest.appEntry === null) return null;
    if (!record.external) return { kind: "builtin" };
    if (record.app === null) return null;
    const { hash, css } = record.app;
    const jsUrl = `${base}/app.js?h=${hash}`;
    const cssUrl = css === null ? null : `${base}/app.css?h=${hash}`;
    return { kind: "external", jsUrl, cssUrl, hash };
  }

  private async discover(): Promise<void> {
    const { config, log, builtins = builtinPlugins } = this.options;
    const found = new Map<string, PluginRecord>();
    const add = async (directory: string, origin: PluginOrigin) => {
      try {
        const manifest = await readManifest(directory);
        const known = this.records.get(manifest.id) ?? { ...UNLOADED };
        found.set(manifest.id, Object.assign(known, origin, { manifest }));
      } catch (error) {
        log.error("Plugin manifest is unreadable", { directory, err: error });
      }
    };
    for (const { directory, server } of builtins) {
      const origin = { server, external: false, watch: false };
      await add(directory, { ...origin, configEnabled: true });
    }
    const { configFile } = dataPaths(config.dataDir);
    const entries = await readExternalPluginEntries(configFile).catch(
      (error: unknown) => {
        log.error("config.json is unreadable", { configFile, err: error });
        return [];
      },
    );
    for (const { path, enabled, watch } of entries) {
      const origin = { server: null, external: true, watch };
      await add(path, { ...origin, configEnabled: enabled });
    }
    for (const [id, record] of this.records) {
      if (found.has(id)) continue;
      this.watchers.get(id)?.close();
      this.watchers.delete(id);
      await this.inOrder(() => this.unload(record));
    }
    this.records.clear();
    for (const [id, record] of found) this.records.set(id, record);
  }

  private load(record: PluginRecord): Promise<void> {
    return this.inOrder(() => this.start(record));
  }

  private async start(record: PluginRecord): Promise<void> {
    await this.unload(record);
    this.watch(record);
    if (!this.isEnabled(record)) return;
    const { config, db, hub, log, tunnelToken, kernel } = this.options;
    const { id, serverEntry, appEntry } = record.manifest;
    const { dataDir } = config;
    const serverUrl = loopbackUrl(config);
    const server = { dataDir, serverUrl, tunnelToken };
    const { instance, api } = createPluginInstance(
      { db, hub, log, kernel, ...server, deps: this.deps },
      id,
      record.external ? "installed" : "product",
    );
    try {
      for (const required of record.manifest.requires) {
        if (this.records.get(required)?.instance != null) continue;
        throw new Error(`requires "${required}", which is not running`);
      }
      if (record.external && appEntry !== null) {
        record.app = await bundleApp(appEntry);
      }
      const cacheDir = join(dataPaths(dataDir).plugins, id, ".cache");
      const entry =
        record.external && serverEntry !== null
          ? await importServerEntry(serverEntry, cacheDir)
          : record.server;
      await entry?.(api);
      record.instance = instance;
      instance.startServices();
    } catch (error) {
      await instance.dispose();
      record.error = errorMessage(error);
      log.error("Plugin failed to load", { pluginId: id, err: error });
    }
  }

  idOfDirectory(path: string): string | null {
    const directory = resolve(path);
    for (const { manifest } of this.records.values()) {
      if (manifest.directory === directory) return manifest.id;
    }
    return null;
  }

  private watch(record: PluginRecord): void {
    const { id, directory } = record.manifest;
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    if (!record.watch || !this.isEnabled(record)) return;
    let timer: NodeJS.Timeout | undefined;
    const changed = (_event: string, file: string | null) => {
      if (file !== null && UNWATCHED.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.reload(id).catch((error: unknown) => {
          const fields = { pluginId: id, err: error };
          this.options.log.warn("Plugin reload on change failed", fields);
        });
      }, WATCH_DEBOUNCE_MS);
    };
    try {
      const watcher = watchDirectory(directory, { recursive: true }, changed);
      watcher.on("close", () => clearTimeout(timer));
      watcher.on("error", () => watcher.close());
      this.watchers.set(id, watcher);
    } catch (error) {
      const fields = { pluginId: id, err: error };
      this.options.log.warn("Plugin directory cannot be watched", fields);
    }
  }

  private async unload(record: PluginRecord): Promise<void> {
    const { instance, token } = record;
    Object.assign(record, UNLOADED, { token });
    await instance?.dispose();
  }
}

export async function startPlugins(ctx: ServerContext): Promise<Disposer> {
  const { plugins, runners, log } = ctx;
  const shipped = new Set<string>();
  const sync = async (hostIds: string[]) => {
    const parts = await plugins.runnerParts();
    for (const hostId of hostIds) {
      if (parts.length === 0 && !shipped.has(hostId)) continue;
      if (!runners.isConnected(hostId)) continue;
      shipped.add(hostId);
      try {
        const runner = asSystem(() => runners.get(hostId));
        const { failed } = await runner.loadPlugins({ plugins: parts });
        for (const { id, message } of failed) {
          const fields = { hostId, pluginId: id, message };
          log.warn("A plugin's runner part did not load", fields);
        }
      } catch (error) {
        log.warn("Runner parts were not sent", { hostId, err: error });
      }
    }
  };
  plugins.deps = createPluginHostDeps(ctx);
  plugins.onChanged = () => void sync(runners.connectedHostIds());
  const stopWatching = runners.onConnected((hostId) => void sync([hostId]));
  await plugins.reload();
  return async () => {
    stopWatching();
    plugins.onChanged = () => {};
    await plugins.stop();
  };
}
