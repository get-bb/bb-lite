import { lstat, mkdir, readdir, rm, statfs } from "node:fs/promises";
import { basename, join } from "node:path";
import { killProcessesWithCwdUnder, type PluginRunnerApi } from "@bb/runner";
import { storageRetention, type Entry } from "./contract.js";

export interface StorageFs {
  lstat(
    path: string,
  ): Promise<{ size: number; isDirectory(): boolean; isFile(): boolean }>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  statfs(
    path: string,
  ): Promise<{ blocks: number; bavail: number; bsize: number }>;
}

export const nodeFs: StorageFs = {
  lstat,
  readdir: (path) => readdir(path),
  rm: (path) => rm(path, { recursive: true, force: true }),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  statfs,
};

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function checkName(name: string) {
  if (basename(name) !== name || name === "." || name === "..")
    throw new Error(`Invalid storage entry name: ${name}`);
}

export function storageOps(
  fs: StorageFs,
  stopProcesses: (path: string) => Promise<void> = killProcessesWithCwdUnder,
) {
  async function size(path: string): Promise<number> {
    try {
      const stat = await fs.lstat(path);
      if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
      const names = await fs.readdir(path);
      const sizes = await Promise.all(
        names.map((name) => size(join(path, name))),
      );
      return sizes.reduce((sum, bytes) => sum + bytes, 0);
    } catch (error) {
      if (missing(error)) return 0;
      throw error;
    }
  }

  async function measure({ rootPath }: { rootPath: string }) {
    let names: string[] = [];
    try {
      names = await fs.readdir(rootPath);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const entries: Entry[] = await Promise.all(
      names.map(async (name) => ({
        name,
        sizeBytes: await size(join(rootPath, name)),
      })),
    );
    const disk = await fs.statfs(rootPath).then(
      (stats) => ({
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bavail * stats.bsize,
      }),
      () => null,
    );
    return { disk, entries };
  }

  async function clear(input: {
    rootPath: string;
    names: string[];
    recreate: boolean;
  }) {
    const removed: Entry[] = [];
    for (const name of input.names) {
      checkName(name);
      const path = join(input.rootPath, name);
      const sizeBytes = await size(path);
      await stopProcesses(path);
      await fs.rm(path);
      if (input.recreate) await fs.mkdir(path);
      removed.push({ name, sizeBytes });
    }
    return { removed };
  }

  async function largeFiles(path: string, minBytes: number) {
    const found: { path: string; size: number }[] = [];
    const walk = async (current: string): Promise<void> => {
      const stat = await fs.lstat(current).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (stat?.isFile() && stat.size >= minBytes)
        found.push({ path: current, size: stat.size });
      if (!stat?.isDirectory()) return;
      for (const name of await fs.readdir(current))
        await walk(join(current, name));
    };
    await walk(path);
    return found;
  }

  async function discardLargeFiles(input: {
    rootPath: string;
    names: string[];
    minBytes: number;
  }) {
    const removed: (Entry & { count: number })[] = [];
    for (const name of input.names) {
      checkName(name);
      const files = await largeFiles(
        join(input.rootPath, name),
        input.minBytes,
      );
      for (const file of files) await fs.rm(file.path);
      removed.push({
        name,
        count: files.length,
        sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      });
    }
    return { removed };
  }

  return { measure, clear, discardLargeFiles };
}

export function createStorageRunner(fs: StorageFs) {
  return (bb: PluginRunnerApi): void => {
    const ops = storageOps(fs);
    bb.implement(storageRetention.measure, ops.measure);
    bb.implement(storageRetention.clear, ops.clear);
    bb.implement(storageRetention.discardLargeFiles, ops.discardLargeFiles);
  };
}

export default function storageRetentionRunner(bb: PluginRunnerApi): void {
  createStorageRunner(nodeFs)(bb);
}
