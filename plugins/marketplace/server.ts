import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  API_VERSION,
  fail,
  isNewer,
  plugins,
  satisfies,
  type PluginServerApi,
} from "@bb/plugin";
import { pluginDev } from "bb-plugin-plugin-dev/contract.js";
import {
  catalogEntrySchema,
  catalogFileSchema,
  marketplace,
  type CatalogEntry,
  type Installed,
  type Offered,
} from "./contract.js";

export const OFFICIAL_CATALOG =
  "https://getbb.app/marketplace/v2/marketplace.json";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_MS = 2 * 60 * 60_000;

type Loaded = { entries: CatalogEntry[]; at: number };

async function readCatalog(source: string): Promise<CatalogEntry[]> {
  const remote = /^https?:\/\//u.test(source);
  const text = remote
    ? await fetch(source, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
    : await readFile(
        source.startsWith("file:") ? fileURLToPath(source) : source,
        "utf8",
      );
  const file = catalogFileSchema.parse(JSON.parse(text));
  return file.plugins.flatMap((raw) => {
    const parsed = catalogEntrySchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

function offer(
  entry: CatalogEntry,
  catalog: string,
  installed: Installed | null,
): Offered {
  const common = {
    id: entry.id,
    name: entry.displayName ?? entry.id,
    description: entry.description,
    author: entry.author?.name ?? null,
    catalog,
    engine: entry.engines?.bb ?? null,
    parts: entry.parts ?? null,
    installed,
  };
  const { source } = entry;
  if ("git" in source) {
    const { url, subdir, ref, range, tagPrefix } = source.git;
    return {
      ...common,
      source: `git:${url}`,
      ref: ref ?? null,
      range: range ?? null,
      tagPrefix: tagPrefix ?? null,
      subdir: subdir ?? null,
      installable: true,
    };
  }
  if ("npm" in source) {
    const { package: name, range, tag } = source.npm;
    return {
      ...common,
      source: `npm:${name}`,
      ref: tag ?? null,
      range: range ?? null,
      tagPrefix: null,
      subdir: null,
      installable: true,
    };
  }
  return {
    ...common,
    source: `builtin:${source.bundled.plugin}`,
    ref: null,
    range: null,
    tagPrefix: null,
    subdir: null,
    installable: false,
  };
}

function installerInput(offered: Offered, version: string | null) {
  const range = version ?? offered.range;
  const tagPrefix = offered.tagPrefix ?? undefined;
  if (offered.source.startsWith("npm:")) {
    return {
      source: offered.source,
      version: range ?? offered.ref ?? undefined,
    };
  }
  const subdir = offered.subdir === null ? "" : `:${offered.subdir}`;
  if (range !== null) {
    const source = `${offered.source}#${subdir}`;
    return { source, version: range, tagPrefix };
  }
  return { source: `${offered.source}#${offered.ref ?? ""}${subdir}` };
}

export default function plugin(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    catalogs: {
      type: "string",
      label: "Catalogs",
      description:
        "Plugin catalogs to offer, one per line: an https URL or a local file.",
      multiline: true,
      default: OFFICIAL_CATALOG,
    },
  });
  const cache = new Map<string, Loaded>();
  const key = (id: string) => `installed:${id}`;
  const record = (id: string) => bb.storage.kv.get<Installed>(key(id));
  const records = async () => {
    const keys = await bb.storage.kv.list("installed:");
    const rows = await Promise.all(
      keys.map((k) => bb.storage.kv.get<Installed>(k)),
    );
    return rows.flatMap((row) => (row === undefined ? [] : [row]));
  };

  const load = async (refresh: boolean) => {
    const { catalogs } = await settings.get();
    const sources = catalogs
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const errors: { catalog: string; message: string }[] = [];
    const offered = new Map<string, { entry: CatalogEntry; catalog: string }>();
    for (const catalog of sources) {
      let loaded = cache.get(catalog);
      if (
        refresh ||
        loaded === undefined ||
        Date.now() - loaded.at > CACHE_MS
      ) {
        try {
          loaded = { entries: await readCatalog(catalog), at: Date.now() };
          cache.set(catalog, loaded);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push({ catalog, message });
          if (loaded === undefined) continue;
        }
      }
      for (const entry of loaded.entries) {
        if (!offered.has(entry.id)) offered.set(entry.id, { entry, catalog });
      }
    }
    return { offered, errors };
  };

  const find = async (id: string) => {
    const { offered } = await load(false);
    const found = offered.get(id);
    if (found === undefined) fail("not_found", `No catalog offers "${id}"`);
    return offer(found.entry, found.catalog, (await record(id)) ?? null);
  };

  const install = async (
    offered: Offered,
    version: string | null,
    replace: boolean,
  ): Promise<Installed> => {
    if (!offered.installable) {
      fail("invalid", `${offered.id} is built into bb; enable it in Settings`);
    }
    if (offered.engine !== null && !satisfies(API_VERSION, offered.engine)) {
      fail("invalid", `${offered.id} needs bb API ${offered.engine}`, {
        reason: "engine_mismatch",
      });
    }
    const input = installerInput(offered, version);
    const done = await bb.call(pluginDev.install, { ...input, replace });
    const row: Installed = {
      id: offered.id,
      pluginId: done.id,
      catalog: offered.catalog,
      source: input.source,
      ref: done.ref ?? null,
      range: version ?? offered.range,
      tagPrefix: offered.tagPrefix,
      version: done.version ?? null,
      path: done.path,
      installedAt: Date.now(),
    };
    await bb.storage.kv.set(key(offered.id), row);
    bb.changed(marketplace.list);
    return row;
  };

  const latest = async (row: Installed) => {
    if (row.range === null) return null;
    const versions = await bb.call(pluginDev.versions, {
      source: row.source,
      tagPrefix: row.tagPrefix ?? undefined,
    });
    let best: string | null = null;
    for (const version of versions) {
      if (!satisfies(version, row.range)) continue;
      if (best === null || isNewer(version, best)) best = version;
    }
    const newer =
      best !== null && (row.version === null || isNewer(best, row.version));
    return newer ? best : null;
  };

  bb.implement(marketplace.catalog, async ({ query, refresh }) => {
    const { offered, errors } = await load(refresh === true);
    const installed = new Map((await records()).map((row) => [row.id, row]));
    const words = (query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
    const entries = [...offered.values()]
      .map(({ entry, catalog }) =>
        offer(entry, catalog, installed.get(entry.id) ?? null),
      )
      .filter((entry) => {
        const text =
          `${entry.id} ${entry.name} ${entry.description}`.toLowerCase();
        return words.every((word) => text.includes(word));
      });
    return { entries, errors };
  });

  bb.implement(marketplace.list, () => records());

  bb.implement(marketplace.install, async ({ id, version }) => {
    if ((await record(id)) !== undefined) {
      fail("conflict", `${id} is already installed`, {
        hint: `bb marketplace update ${id}`,
      });
    }
    return install(await find(id), version ?? null, false);
  });

  bb.implement(marketplace.updates, async () => {
    const rows = await records();
    const found = await Promise.all(
      rows.map(async (row) => ({ row, latest: await latest(row) })),
    );
    return found.flatMap(({ row, latest: next }) =>
      next === null ? [] : [{ id: row.id, version: row.version, latest: next }],
    );
  });

  bb.implement(marketplace.update, async ({ id }) => {
    const row = await record(id);
    if (row === undefined) fail("not_found", `${id} is not installed`);
    if ((await latest(row)) === null) return row;
    const offered = await find(id);
    return install({ ...offered, catalog: row.catalog }, row.range, true);
  });

  bb.implement(marketplace.uninstall, async ({ id }) => {
    const row = await record(id);
    if (row === undefined) fail("not_found", `${id} is not installed`);
    await bb.call(plugins.uninstall, { path: row.path });
    await rm(row.path.split("/node_modules/")[0] ?? row.path, {
      recursive: true,
      force: true,
    });
    await bb.storage.kv.delete(key(id));
    bb.changed(marketplace.list);
    return { id };
  });
}
