import type { FileSource } from "@bb/plugin/app";
import type { MarkdownLinkRouting } from "../components/ui/markdown-link-routing";

const served = (path: string) =>
  path.replace(/^\/+/u, "").split("/").map(encodeURIComponent).join("/");

export function defaultFileSource(path: string, source?: FileSource) {
  return source ?? (path.startsWith("/") ? "host" : "workspace");
}

export function unifiedPatch(patch: string, path = "file"): string {
  if (/^(diff --git |--- )/mu.test(patch)) return patch;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`;
}

export function markdownDocumentRouting(document: {
  path: string;
  url: string;
  open(path: string): boolean;
}): MarkdownLinkRouting {
  const { path, url, open } = document;
  const absolute = path.startsWith("/");
  const file = absolute ? path : `/${path}`;
  const relative = { baseDir: file.slice(0, file.lastIndexOf("/")) || "/" };
  const paths = { ...relative, rootPath: "/" };
  const contained = { kind: "contained" as const, rootPath: "/" };
  const prefix = url.slice(0, url.length - served(path).length);
  return {
    localFile: {
      absoluteLinks: contained,
      relativeLinks: paths,
      onOpenLink: (link) => open(absolute ? link.path : link.path.slice(1)),
    },
    localImage: {
      absolutePaths: contained,
      relativePaths: paths,
      resolveSrc: (image) => `${prefix}${served(image.path)}`,
    },
  };
}
