import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { lookup } from "mime-types";
import type { ApiApp } from "./api.js";

const INDEX_PATH = "/index.html";
const ASSETS_PREFIX = "/assets/";

function cacheControl(urlPath: string): string {
  if (urlPath.startsWith(ASSETS_PREFIX)) {
    return "public, max-age=31536000, immutable";
  }
  return urlPath.endsWith(".html") ? "no-cache" : "public, max-age=86400";
}

function matchesEntityTag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const opaque = etag.replace(/^W\//u, "");
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//u, ""))
    .some((candidate) => candidate === "*" || candidate === opaque);
}

async function readIfFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function fileResponse(
  urlPath: string,
  content: Buffer,
  ifNoneMatch: string | undefined,
): Response {
  const headers = new Headers({
    "cache-control": cacheControl(urlPath),
    "content-type": lookup(urlPath) || "application/octet-stream",
  });
  if (urlPath.endsWith(".html")) {
    const digest = createHash("sha256").update(content).digest("hex");
    const etag = `W/"${digest.slice(0, 32)}"`;
    headers.set("etag", etag);
    if (matchesEntityTag(ifNoneMatch, etag)) {
      headers.delete("content-type");
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(new Uint8Array(content), { headers });
}

export function registerStaticApp(app: ApiApp, appDir: string): void {
  const root = resolve(appDir);
  app.get("*", async (context) => {
    const ifNoneMatch = context.req.header("if-none-match");
    const decoded = decodePath(context.req.path);
    if (decoded === null) return context.notFound();
    const urlPath = decoded === "/" ? INDEX_PATH : decoded;
    const filePath = join(root, urlPath);
    const content = filePath.startsWith(root + sep)
      ? await readIfFile(filePath)
      : null;
    if (content !== null) return fileResponse(urlPath, content, ifNoneMatch);
    if (urlPath.startsWith(ASSETS_PREFIX)) return context.notFound();
    const index = await readIfFile(join(root, INDEX_PATH));
    if (index !== null) return fileResponse(INDEX_PATH, index, ifNoneMatch);
    return urlPath === INDEX_PATH
      ? context.text("bb server")
      : context.notFound();
  });
}
