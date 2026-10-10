const PDF_MIME_TYPE = "application/pdf";

function isPdfMimeType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
}

export async function loadPdfBlob(
  url: string,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok) {
    throw new Error(`PDF request failed with status ${response.status}.`);
  }
  if (!isPdfMimeType(response.headers.get("content-type"))) {
    throw new Error("The file response was not a PDF.");
  }
  return response.blob();
}
