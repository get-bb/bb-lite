import type { EnvironmentFilePreviewSource } from "@bb/client-core";

const API = "/api/v1";

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
  const query = new URLSearchParams({ path }).toString();
  const project = encodeURIComponent(projectId);
  return `${API}/projects/${project}/attachments/content?${query}`;
}

export function buildEnvironmentFileContentUrl(
  environmentId: string,
  source: EnvironmentFilePreviewSource,
  path: string,
): string {
  const filePath = encodePathSegments(path);
  const environment = `${API}/environments/${encodeURIComponent(environmentId)}`;
  if (source.kind === "working-tree") return `${environment}/files/${filePath}`;
  const ref = source.kind === "head" ? "HEAD" : source.ref;
  return `${environment}/revisions/${encodeURIComponent(ref)}/files/${filePath}`;
}

export function buildThreadHostFileContentUrl(
  threadId: string,
  absolutePath: string,
): string {
  const thread = encodeURIComponent(threadId);
  return `${API}/threads/${thread}/host-files/${encodeHostFilePath(absolutePath)}`;
}
