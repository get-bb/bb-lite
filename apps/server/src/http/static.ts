import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { contentType } from "mime-types";
import type { ApiApp } from "./api.js";
import { encodeStatic } from "./compression.js";
import { matchesEntityTag } from "./range.js";

const INDEX_PATH = "/index.html";
const ASSETS_PREFIX = "/assets/";

function cacheControl(urlPath: string): string {
  if (urlPath.startsWith(ASSETS_PREFIX)) {
    return "public, max-age=31536000, immutable";
  }
  return urlPath.endsWith(".html") ? "no-cache" : "public, max-age=86400";
}

function readIfFile(path: string): Promise<Buffer | null> {
  return readFile(path).catch(() => null);
}

function decodePath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

async function fileResponse(
  urlPath: string,
  content: Buffer,
  request: { header(name: string): string | undefined },
) {
  const ifNoneMatch = request.header("if-none-match");
  const headers = new Headers({
    "cache-control": cacheControl(urlPath),
    "content-type": contentType(extname(urlPath)) || "application/octet-stream",
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
  const acceptEncoding = request.header("accept-encoding");
  const body = await encodeStatic(content, headers, acceptEncoding);
  return new Response(body, { headers });
}

export function registerStaticApp(app: ApiApp, appDir: string): void {
  const root = resolve(appDir);
  app.get("*", async (context) => {
    const decoded = decodePath(context.req.path);
    if (decoded === null) return context.notFound();
    const urlPath = decoded === "/" ? INDEX_PATH : decoded;
    const filePath = join(root, urlPath);
    const content = filePath.startsWith(root + sep)
      ? await readIfFile(filePath)
      : null;
    if (content !== null) return fileResponse(urlPath, content, context.req);
    if (urlPath.startsWith(ASSETS_PREFIX)) return context.notFound();
    const index = await readIfFile(join(root, INDEX_PATH));
    if (index !== null) return fileResponse(INDEX_PATH, index, context.req);
    return urlPath === INDEX_PATH
      ? context.text("bb server")
      : context.notFound();
  });
}
