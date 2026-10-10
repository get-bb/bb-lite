import { CallError } from "@bb/plugin/app";
import { extractErrorMessage, toRecord } from "@bb/core-ui";
import {
  FILE_PREVIEW_SAMPLE_BYTES,
  buildFilePreview,
  buildFilePreviewFromSample,
  normalizeFilePreviewMimeType,
  type FilePreview,
  type FilePreviewTarget,
} from "@bb/client-core";

async function httpError(response: Response): Promise<CallError> {
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const code = toRecord(body)?.code;
  return new CallError({
    body,
    code: typeof code === "string" ? code : null,
    message:
      extractErrorMessage(body) ?? (response.statusText || "Request failed"),
    status: response.status,
  });
}

async function ok(pending: Promise<Response>): Promise<Response> {
  const response = await pending;
  if (!response.ok) throw await httpError(response);
  return response;
}

function mimeTypeOf(response: Response): string {
  return normalizeFilePreviewMimeType(response.headers.get("content-type"));
}

export async function loadFilePreview(
  target: FilePreviewTarget,
  signal?: AbortSignal,
): Promise<FilePreview> {
  const range = `bytes=0-${FILE_PREVIEW_SAMPLE_BYTES - 1}`;
  const sample = await fetch(target.url, {
    cache: "no-store",
    headers: { range },
    signal,
  });
  if (sample.status === 416) {
    const contentBytes = new Uint8Array();
    const mimeType = mimeTypeOf(sample);
    return buildFilePreview({ ...target, contentBytes, mimeType });
  }
  if (!sample.ok) throw await httpError(sample);
  const sampleBytes = new Uint8Array(await sample.arrayBuffer());
  const total = Number(sample.headers.get("content-range")?.split("/")[1]);
  if (sample.status === 206 && !(Number.isSafeInteger(total) && total >= 0)) {
    throw new Error("File response has no usable Content-Range size");
  }
  const sizeBytes = sample.status === 206 ? total : sampleBytes.byteLength;
  const mimeType = mimeTypeOf(sample);
  if (sampleBytes.byteLength >= sizeBytes) {
    return buildFilePreview({ ...target, contentBytes: sampleBytes, mimeType });
  }
  const sampled = { ...target, mimeType, sampleBytes, sizeBytes };
  const preview = buildFilePreviewFromSample(sampled);
  if (preview !== null) return preview;
  const response = await ok(fetch(target.url, { signal }));
  return buildFilePreview({
    ...target,
    contentBytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: mimeTypeOf(response),
  });
}
