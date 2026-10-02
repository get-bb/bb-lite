import { publicApiRoutes } from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { pick, type Http } from "../http.js";

type Abortable = { signal?: AbortSignal };

export interface FileWriteArgs {
  hostId?: string;
  path: string;
  rootPath?: string;
  content: string;
  contentEncoding?: "utf8" | "base64";
  createParents?: boolean;
  expectedSha256?: string | null;
  mode?: number;
}

export interface FileListArgs extends Abortable {
  hostId?: string;
  path: string;
  query?: string;
  limit?: number;
  includeHidden?: boolean;
  excludeNames?: string[];
}

export interface FilesArea {
  read(
    args: Abortable & { hostId?: string; path: string; rootPath?: string },
  ): Promise<api.HostFileReadResponse>;
  write(args: FileWriteArgs): Promise<api.HostFileWriteResponse>;
  list(args: FileListArgs): Promise<api.HostFileListResponse>;
}

export function createFilesArea(http: Http): FilesArea {
  const routes = publicApiRoutes.files;
  return {
    read(args) {
      const json = pick(args, ["hostId", "path", "rootPath"]);
      return http.json(routes.read, { json }, args.signal);
    },
    write: (json) => http.json(routes.write, { json }),
    list(args) {
      const json = pick(args, [
        "excludeNames",
        "hostId",
        "includeHidden",
        "limit",
        "path",
        "query",
      ]);
      return http.json(routes.list, { json }, args.signal);
    },
  };
}
