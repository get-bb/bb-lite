import type {
  HostFileListResponse,
  HostFileReadResponse,
  HostFileWriteResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface FileReadArgs {
  hostId?: string;
  path: string;
  rootPath?: string;
  signal?: AbortSignal;
}

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

export interface FileListArgs {
  hostId?: string;
  path: string;
  query?: string;
  limit?: number;
  includeHidden?: boolean;
  excludeNames?: string[];
  signal?: AbortSignal;
}

export type FileReadResult = HostFileReadResponse;
export type FileWriteResult = HostFileWriteResponse;
export type FileListResult = HostFileListResponse;

export interface FilesArea {
  read(args: FileReadArgs): Promise<FileReadResult>;
  write(args: FileWriteArgs): Promise<FileWriteResult>;
  list(args: FileListArgs): Promise<FileListResult>;
}

export function createFilesArea(args: CreateSdkAreaArgs): FilesArea {
  const { transport } = args;
  return {
    async read(input) {
      return transport.readJson(
        transport.api.v1.files.read.$post(
          {
            json: {
              hostId: input.hostId,
              path: input.path,
              rootPath: input.rootPath,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async write(input) {
      return transport.readJson(
        transport.api.v1.files.write.$post({ json: input }),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.files.list.$post(
          {
            json: {
              excludeNames: input.excludeNames,
              hostId: input.hostId,
              includeHidden: input.includeHidden,
              limit: input.limit,
              path: input.path,
              query: input.query,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
