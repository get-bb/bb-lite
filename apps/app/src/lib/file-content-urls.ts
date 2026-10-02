import type { EnvironmentFilePreviewSource } from "@bb/client-core";
import { apiClient, toRelativeUrl } from "./api-server";

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeHostFilePath(absolutePath: string): string {
  return encodePathSegments(
    absolutePath.replace(/\\/gu, "/").replace(/^\/+/u, ""),
  );
}

export function buildProjectAttachmentContentUrl(
  projectId: string,
  path: string,
): string {
  return toRelativeUrl(
    apiClient.projects[":id"].attachments.content.$url({
      param: { id: projectId },
      query: { path },
    }),
  );
}

export function buildEnvironmentFileContentUrl(
  environmentId: string,
  source: EnvironmentFilePreviewSource,
  path: string,
): string {
  const filePath = encodePathSegments(path);
  if (source.kind === "working-tree") {
    return toRelativeUrl(
      apiClient.environments[":id"].files[":filePath{.+}"].$url({
        param: { id: environmentId, filePath },
      }),
    );
  }
  return toRelativeUrl(
    apiClient.environments[":id"].revisions[":ref"].files[":filePath{.+}"].$url(
      {
        param: {
          id: environmentId,
          ref: source.kind === "head" ? "HEAD" : source.ref,
          filePath,
        },
      },
    ),
  );
}

export function buildThreadHostFileContentUrl(
  threadId: string,
  absolutePath: string,
): string {
  return toRelativeUrl(
    apiClient.threads[":id"]["host-files"][":filePath{.+}"].$url({
      param: { id: threadId, filePath: encodeHostFilePath(absolutePath) },
    }),
  );
}
