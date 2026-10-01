import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenTarget, WorkspaceApi } from "../workspace-types.js";
import { fail, requireAbsolute, type Method } from "./exec.js";

type OpenRequest = Parameters<WorkspaceApi["openInTarget"]>[0];

interface Target extends Pick<OpenTarget, "id" | "label" | "kind"> {
  executables: string[];
  launch(request: OpenRequest, directory: string): string[] | { cwd: string };
}

const mac = process.platform === "darwin";

function position({ path: file, line, column }: OpenRequest): string {
  const suffix = column === null ? "" : `:${column}`;
  return line === null ? file : `${file}:${line}${suffix}`;
}

function gotoEditor(id: string, label: string, command: string): Target {
  const launch: Target["launch"] = (request) =>
    request.line === null ? [request.path] : ["-g", position(request)];
  return { id, label, kind: "editor", executables: [command], launch };
}

const TARGETS: Target[] = [
  gotoEditor("vscode", "VS Code", "code"),
  gotoEditor("cursor", "Cursor", "cursor"),
  {
    id: "zed",
    label: "Zed",
    kind: "editor",
    executables: ["zed"],
    launch: (request) => [position(request)],
  },
  {
    id: "file-manager",
    label: mac ? "Finder" : "File Manager",
    kind: "file-manager",
    executables: [mac ? "open" : "xdg-open"],
    launch: (_request, directory) => [directory],
  },
  {
    id: "terminal",
    label: "Terminal",
    kind: "terminal",
    executables: mac
      ? ["open"]
      : ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"],
    launch: (_request, directory) =>
      mac ? ["-a", "Terminal", directory] : { cwd: directory },
  },
];

async function findExecutable(
  names: string[],
  searchPath: string,
): Promise<string | null> {
  const directories = searchPath.split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      const found = await fs.access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      );
      if (found) {
        return candidate;
      }
    }
  }
  return null;
}

export const listOpenTargets: Method<"listOpenTargets"> = async (ctx) => {
  const searchPath = (await ctx.env()).PATH ?? "";
  const found = await Promise.all(
    TARGETS.map((target) => findExecutable(target.executables, searchPath)),
  );
  const available = TARGETS.filter((_target, index) => found[index] !== null);
  return {
    targets: available.map(({ id, label, kind }) => ({
      id,
      label,
      kind,
      capabilities: {
        openDirectory: true,
        openFile: kind !== "terminal",
        openFileAtLine: kind === "editor",
        openFileAtColumn: kind === "editor",
      },
    })),
  };
};

export const openInTarget: Method<"openInTarget"> = async (ctx, request) => {
  const env = await ctx.env();
  const target = TARGETS.find(({ id }) => id === request.targetId);
  const file = await findExecutable(target?.executables ?? [], env.PATH ?? "");
  if (target === undefined || file === null) {
    fail("unavailable", `Open target is unavailable: ${request.targetId}`);
  }
  const stat = await fs.stat(requireAbsolute(request.path));
  const directory = stat.isDirectory()
    ? request.path
    : path.dirname(request.path);
  const launch = target.launch(request, directory);
  const [args, cwd] = Array.isArray(launch) ? [launch] : [[], launch.cwd];
  await new Promise<void>((resolve, reject) => {
    const options = { cwd, detached: true, env, stdio: "ignore" } as const;
    const child = spawn(file, args, options);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
