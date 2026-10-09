import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@bb/domain";
import type {
  SettingDescriptor,
  SettingDescriptors,
  SettingScope,
  SettingValue,
} from "@bb/plugin";
import type { Db } from "@bb/server-kit/db/index";
import { readPluginRows, writePluginRow } from "@bb/server-kit/db/plugins";
import { invalidRequest } from "@bb/server-kit/http/errors";

export type SettingRecord = Record<string, SettingValue | undefined>;
type SettingsListener = (next: SettingRecord, previous: SettingRecord) => void;

const SECRET_FILE_MODE = 0o600;
const PROJECT_EXISTS =
  "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL";

function isSecret(descriptor: SettingDescriptor): boolean {
  return descriptor.type === "string" && descriptor.secret === true;
}

function accepted(
  descriptor: SettingDescriptor,
  value: unknown,
): SettingValue | undefined {
  if (descriptor.type === "select") {
    const known = descriptor.options.some((option) => option.value === value);
    return known ? (value as string) : undefined;
  }
  if (descriptor.type === "project") {
    return typeof value === "string" ? value : undefined;
  }
  if (descriptor.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const { min = -Infinity, max = Infinity, integer = false } = descriptor;
    const whole = !integer || Number.isInteger(value);
    return whole && value >= min && value <= max ? value : undefined;
  }
  return typeof value === descriptor.type ? (value as SettingValue) : undefined;
}

export class PluginSettings {
  descriptors: SettingDescriptors = {};
  readonly listeners: SettingsListener[] = [];
  private readonly personal = new Set<string>();
  private readonly perProject = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly pluginId: string,
    private readonly secretsDir: string,
  ) {}

  define(descriptors: SettingDescriptors, scope: SettingScope): void {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const own = descriptor.scope ?? scope;
      const shared = isSecret(descriptor) || own === "workspace";
      const stored = shared ? descriptor : { ...descriptor, scope: own };
      this.descriptors = { ...this.descriptors, [key]: stored };
      if (shared) continue;
      (own === "user" ? this.personal : this.perProject).add(key);
    }
  }

  isPersonal(keys: readonly string[], projectId?: string | null): boolean {
    const own = (key: string) =>
      this.personal.has(key) || (this.perProject.has(key) && !!projectId);
    return keys.length > 0 && keys.every(own);
  }

  private rowKey(
    key: string,
    userId: string | null,
    projectId: string | null,
  ): string {
    if (projectId !== null && this.perProject.has(key)) {
      return `${key}#${projectId}`;
    }
    const own = userId !== null && this.personal.has(key);
    return own ? `${key}@${userId}` : key;
  }

  async read(
    userId: string | null = null,
    projectId: string | null = null,
  ): Promise<SettingRecord> {
    const rows = readPluginRows(this.db, "plugin_settings", this.pluginId);
    const values: SettingRecord = {};
    for (const [key, descriptor] of Object.entries(this.descriptors)) {
      const row = this.rowKey(key, userId, projectId);
      const own = rows.get(row) ?? rows.get(key);
      const stored: unknown = isSecret(descriptor)
        ? await readFile(join(this.secretsDir, key), "utf8").catch(() => null)
        : JSON.parse(own ?? "null");
      values[key] = accepted(descriptor, stored) ?? descriptor.default;
    }
    return values;
  }

  async write(
    update: Record<string, unknown>,
    userId: string | null = null,
    projectId: string | null = null,
  ): Promise<SettingRecord> {
    if (
      projectId !== null &&
      this.db.get(PROJECT_EXISTS, projectId) === undefined
    ) {
      throw invalidRequest(`Unknown project: ${projectId}`);
    }
    const entries = Object.entries(update).map(([key, value]) => {
      const descriptor = this.descriptors[key];
      if (descriptor === undefined) {
        throw invalidRequest(`Unknown setting "${key}"`);
      }
      if (value !== null && accepted(descriptor, value) === undefined) {
        throw invalidRequest(`Invalid value for setting "${key}"`);
      }
      if (
        descriptor.type === "project" &&
        value !== null &&
        this.db.get(PROJECT_EXISTS, String(value)) === undefined
      ) {
        throw invalidRequest(`Setting "${key}" names no project: ${value}`);
      }
      return { key, value, secret: isSecret(descriptor) };
    });
    const previous = await this.read(userId, projectId);
    for (const { key, value, secret } of entries) {
      if (!secret) {
        const stored = value === null ? null : JSON.stringify(value);
        const row = this.rowKey(key, userId, projectId);
        writePluginRow(this.db, "plugin_settings", this.pluginId, row, stored);
      } else if (value === null) {
        await rm(join(this.secretsDir, key), { force: true });
      } else {
        await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
        const file = join(this.secretsDir, key);
        await writeFile(file, String(value), { mode: SECRET_FILE_MODE });
        await chmod(file, SECRET_FILE_MODE);
      }
    }
    const next = await this.read(userId, projectId);
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      for (const listener of this.listeners) listener(next, previous);
    }
    return next;
  }

  async publicValues(
    userId: string | null = null,
    projectId: string | null = null,
  ): Promise<Record<string, JsonValue>> {
    const values = await this.read(userId, projectId);
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
