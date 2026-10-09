import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
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
  type CatalogSource,
  type Installed,
  type Offered,
} from "./contract.js";

export const OFFICIAL_CATALOG =
  "https://getbb.app/marketplace/v2/marketplace.json";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_MS = 2 * 60 * 60_000;
const REFRESH_CRON = "0 */6 * * *";
const NEEDS_BB = /needs bb API (\S+?)(?:;|$)/u;
const run = promisify(execFile);

async function tagCommit(source: string, ref: string) {
  const url = source.slice("git:".length).split("#")[0] ?? "";
  const tag = `refs/tags/${ref}`;
  const listed = await run("git", ["ls-remote", url, tag, `${tag}^{}`], {
    timeout: FETCH_TIMEOUT_MS,
  });
  const rows = listed.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  const named = (name: string) => rows.find((row) => row[1] === name)?.[0];
  return named(`${tag}^{}`) ?? named(tag) ?? null;
}

function needsBb(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  return NEEDS_BB.exec(message)?.[1] ?? null;
}

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
  const failures = new Map<string, string>();
  const available = bb.provide(marketplace.available, 0);
  const sources = async () =>
    (await settings.get()).catalogs
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  const read = async (catalog: string) => {
    try {
      const loaded = { entries: await readCatalog(catalog), at: Date.now() };
      cache.set(catalog, loaded);
      failures.delete(catalog);
      return loaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(catalog, message);
      return message;
    }
  };
  const listCatalogs = async (): Promise<CatalogSource[]> =>
    (await sources()).map((url) => {
      const loaded = cache.get(url);
      return {
        url,
        entries: loaded?.entries.length ?? null,
        refreshedAt: loaded?.at ?? null,
        error: failures.get(url) ?? null,
      };
    });
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
    const errors: { catalog: string; message: string }[] = [];
    const offered = new Map<string, { entry: CatalogEntry; catalog: string }>();
    for (const catalog of await sources()) {
      let loaded = cache.get(catalog);
      if (
        refresh ||
        loaded === undefined ||
        Date.now() - loaded.at > CACHE_MS
      ) {
        const fresh = await read(catalog);
        if (typeof fresh === "string") {
          errors.push({ catalog, message: fresh });
          if (loaded === undefined) continue;
        } else {
          loaded = fresh;
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
    range = version ?? offered.range,
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
      range,
      tagPrefix: offered.tagPrefix,
      version: done.version ?? null,
      path: done.path,
      installedAt: Date.now(),
      commit: done.commit ?? null,
    };
    await bb.storage.kv.set(key(offered.id), row);
    bb.changed(marketplace.list);
    return row;
  };

  const candidates = async (row: Installed) => {
    const { range } = row;
    if (range === null) return [];
    const versions = await bb.call(pluginDev.versions, {
      source: row.source,
      tagPrefix: row.tagPrefix ?? undefined,
    });
    const current = row.version;
    return versions
      .filter((version) => satisfies(version, range))
      .filter((version) => current === null || isNewer(version, current))
      .sort((a, b) => (isNewer(a, b) ? -1 : 1));
  };

  const outdated = async () => {
    const rows = await records();
    const found = await Promise.all(
      rows.map(async (row) => ({ row, newer: await candidates(row) })),
    );
    const updates = found.flatMap(({ row, newer: [next] }) =>
      next === undefined
        ? []
        : [{ id: row.id, version: row.version, latest: next }],
    );
    available.set(updates.length);
    return updates;
  };

  const checkTag = async (row: Installed) => {
    const { ref, commit } = row;
    if (ref === null || !commit || !row.source.startsWith("git:")) return;
    const now = await tagCommit(row.source, ref);
    if (now === null || now === commit) return;
    fail("conflict", `${row.id}: tag ${ref} now points at another commit`, {
      reason: "tag_moved",
      hint: `Check the source, then: bb marketplace update ${row.id} --force`,
    });
  };

  const refreshAll = async () => {
    for (const url of await sources()) await read(url);
    await outdated();
    return listCatalogs();
  };
  bb.background.schedule("refresh", REFRESH_CRON, async () => {
    await refreshAll();
  });

  bb.implement(marketplace.catalogs, listCatalogs);

  bb.implement(marketplace.addCatalog, async ({ url }) => {
    const known = await sources();
    const loaded = await read(url);
    if (typeof loaded === "string") {
      failures.delete(url);
      fail("invalid", `Could not read the catalog ${url}: ${loaded}`);
    }
    if (!known.includes(url)) {
      await settings.set({ catalogs: [...known, url].join("\n") });
    }
    bb.changed(marketplace.catalogs);
    return listCatalogs();
  });

  bb.implement(marketplace.removeCatalog, async ({ url }) => {
    const known = await sources();
    if (!known.includes(url)) fail("not_found", `No catalog ${url}`);
    const catalogs = known.filter((source) => source !== url).join("\n");
    await settings.set({ catalogs });
    cache.delete(url);
    failures.delete(url);
    bb.changed(marketplace.catalogs);
    return listCatalogs();
  });

  bb.implement(marketplace.refresh, async ({ url }) => {
    if (url === undefined) return refreshAll();
    if (!(await sources()).includes(url))
      fail("not_found", `No catalog ${url}`);
    await read(url);
    return listCatalogs();
  });

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
    if (/[/\\]|^[.~]/u.test(id)) {
      fail("invalid", `"${id}" is a path, not a marketplace id`, {
        hint: `bb plugin add ${id}`,
      });
    }
    if ((await record(id)) !== undefined) {
      fail("conflict", `${id} is already installed`, {
        hint: `bb marketplace update ${id}`,
      });
    }
    return install(await find(id), version ?? null, false);
  });

  bb.implement(marketplace.updates, outdated);

  bb.implement(marketplace.update, async ({ id, force }) => {
    const row = await record(id);
    if (row === undefined) fail("not_found", `${id} is not installed`);
    const newer = await candidates(row);
    if (newer.length === 0) return { ...row, newer: null };
    if (force !== true) await checkTag(row);
    const offered = { ...(await find(id)), catalog: row.catalog };
    let skipped: { version: string; needsBb: string } | null = null;
    for (const version of newer) {
      try {
        const done = await install(offered, version, true, row.range);
        await outdated();
        return { ...done, newer: skipped };
      } catch (error) {
        const needs = needsBb(error);
        if (needs === null) throw error;
        skipped ??= { version, needsBb: needs };
      }
    }
    return { ...row, newer: skipped };
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
