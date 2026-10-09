import type { FileViewer } from "@bb/plugin/app";

export function matchesFileViewer(viewer: FileViewer, path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
  if (extension !== null && viewer.extensions.includes(extension)) return true;
  return viewer.names?.includes(name) ?? false;
}
