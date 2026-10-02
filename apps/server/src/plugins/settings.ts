import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@bb/domain";
import type {
  SettingDescriptor,
  SettingDescriptors,
  SettingValue,
} from "@bb/plugin";
import type { Db } from "../db/index.js";
import { readPluginRows, writePluginRow } from "../db/plugins.js";
import { invalidRequest } from "../http/errors.js";

export type SettingRecord = Record<string, SettingValue | undefined>;
type SettingsListener = (next: SettingRecord, previous: SettingRecord) => void;

const SECRET_FILE_MODE = 0o600;

function isSecret(descriptor: SettingDescriptor): boolean {
  return descriptor.type === "string" && descriptor.secret === true;
}

function accepted(
  descriptor: SettingDescriptor,
  value: unknown,
): SettingValue | undefined {
  return typeof value === descriptor.type ? (value as SettingValue) : undefined;
}

export class PluginSettings {
  descriptors: SettingDescriptors = {};
  readonly listeners: SettingsListener[] = [];

  constructor(
    private readonly db: Db,
    private readonly pluginId: string,
    private readonly secretsDir: string,
  ) {}

  define(descriptors: SettingDescriptors): void {
    this.descriptors = { ...this.descriptors, ...descriptors };
  }

  async read(): Promise<SettingRecord> {
    const rows = readPluginRows(this.db, "plugin_settings", this.pluginId);
    const values: SettingRecord = {};
    for (const [key, descriptor] of Object.entries(this.descriptors)) {
      const stored: unknown = isSecret(descriptor)
        ? await readFile(join(this.secretsDir, key), "utf8").catch(() => null)
        : JSON.parse(rows.get(key) ?? "null");
      values[key] = accepted(descriptor, stored) ?? descriptor.default;
    }
    return values;
  }

  async write(update: Record<string, unknown>): Promise<SettingRecord> {
    const entries = Object.entries(update).map(([key, value]) => {
      const descriptor = this.descriptors[key];
      if (descriptor === undefined) {
        throw invalidRequest(`Unknown setting "${key}"`);
      }
      if (value !== null && accepted(descriptor, value) === undefined) {
        throw invalidRequest(`Invalid value for setting "${key}"`);
      }
      return { key, value, secret: isSecret(descriptor) };
    });
    const previous = await this.read();
    for (const { key, value, secret } of entries) {
      if (!secret) {
        const stored = value === null ? null : JSON.stringify(value);
        writePluginRow(this.db, "plugin_settings", this.pluginId, key, stored);
      } else if (value === null) {
        await rm(join(this.secretsDir, key), { force: true });
      } else {
        await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
        const file = join(this.secretsDir, key);
        await writeFile(file, String(value), { mode: SECRET_FILE_MODE });
        await chmod(file, SECRET_FILE_MODE);
      }
    }
    const next = await this.read();
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      for (const listener of this.listeners) listener(next, previous);
    }
    return next;
  }

  async publicValues(): Promise<Record<string, JsonValue>> {
    const values = await this.read();
    const visible: Record<string, JsonValue> = {};
    for (const [key, descriptor] of Object.entries(this.descriptors)) {
      const value = values[key];
      if (isSecret(descriptor)) {
        visible[key] = { set: value !== undefined && value !== "" };
      } else if (value !== undefined) {
        visible[key] = value;
      }
    }
    return visible;
  }
}
