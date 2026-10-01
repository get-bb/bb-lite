import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { InstalledPlugin, PluginApp } from "@bb/server-contract";
import { dataPaths, type ServerConfig } from "../config.js";
import type { Logger } from "../context.js";
import type { Db } from "../db/index.js";
import { isPluginEnabled, setPluginEnabled } from "../db/plugins.js";
import type { StartupStep } from "../server.js";
import type { Hub } from "../ws/hub.js";
import { builtinPlugins, type BuiltinPlugin } from "./builtin.js";
import { bundleApp, importServerEntry } from "./bundle.js";
import { createPluginHostDeps, type PluginHostDeps } from "./deps.js";
import { createPluginInstance, errorMessage } from "./instance.js";
import { readExternalPluginEntries, readManifest } from "./manifest.js";
import { PluginRegistry, type PluginRecord } from "./registry.js";

export interface PluginHostOptions {
  config: ServerConfig;
  db: Db;
  hub: Hub;
  log: Logger;
  builtins?: BuiltinPlugin[];
}

type PluginOrigin = Pick<PluginRecord, "server" | "external" | "configEnabled">;

const UNLOADED = { instance: null, app: null, error: null, token: null };

export class PluginHost extends PluginRegistry {
  deps: PluginHostDeps = () => {
    throw new Error("The plugin host has not started");
  };
  private settled: Promise<void> = Promise.resolve();

  constructor(private readonly options: PluginHostOptions) {
    super(options.log);
  }

  async reload(id?: string): Promise<void> {
    await this.discover();
    const targets =
      id === undefined ? [...this.records.values()] : [this.record(id)];
    for (const record of targets) await this.load(record);
    this.options.hub.system(["plugins-changed"]);
  }

  stop(): Promise<void> {
    return this.inOrder(async () => {
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

  async settings(id: string, update?: Record<string, unknown>) {
    const instance = this.running(id);
    if (update !== undefined) {
      await instance.settings.write(update);
      const waiting = instance.needsConfiguration !== null;
      if (waiting) await this.load(this.record(id));
      this.options.hub.system(["plugins-changed"]);
    }
    const { settings } = this.running(id);
    const values = await settings.publicValues();
    return { schema: settings.descriptors, values };
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
    const cli = instance?.cli ?? null;
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
      await add(directory, { server, external: false, configEnabled: true });
    }
    const { configFile } = dataPaths(config.dataDir);
    const entries = await readExternalPluginEntries(configFile).catch(
      (error: unknown) => {
        log.error("config.json is unreadable", { configFile, err: error });
        return [];
      },
    );
    for (const { path, enabled } of entries) {
      await add(path, { server: null, external: true, configEnabled: enabled });
    }
    for (const [id, record] of this.records) {
      if (!found.has(id)) await this.inOrder(() => this.unload(record));
    }
    this.records.clear();
    for (const [id, record] of found) this.records.set(id, record);
  }

  private load(record: PluginRecord): Promise<void> {
    return this.inOrder(() => this.start(record));
  }

  private async start(record: PluginRecord): Promise<void> {
    await this.unload(record);
    if (!this.isEnabled(record)) return;
    const { config, db, hub, log } = this.options;
    const { id, serverEntry, appEntry } = record.manifest;
    const { dataDir } = config;
    const host = config.bindHost === "0.0.0.0" ? "127.0.0.1" : config.bindHost;
    const serverUrl = `http://${host}:${config.port}`;
    const { instance, api } = createPluginInstance(
      { db, hub, log, dataDir, serverUrl, deps: this.deps },
      id,
    );
    try {
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

  private async unload(record: PluginRecord): Promise<void> {
    const { instance, token } = record;
    Object.assign(record, UNLOADED, { token });
    await instance?.dispose();
  }
}

export const startPlugins: StartupStep = async (ctx) => {
  ctx.plugins.deps = createPluginHostDeps(ctx);
  await ctx.plugins.reload();
  return () => ctx.plugins.stop();
};
