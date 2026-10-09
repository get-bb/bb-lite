const DOWNLOAD_RETRY_DELAYS_MS = [500, 1500];

const CHUNK_DOWNLOAD_ERROR =
  /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)/i;

export function isChunkDownloadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_DOWNLOAD_ERROR.test(error.message);
}

export async function loadWithDownloadRetries<T>(
  load: () => Promise<T>,
  delaysMs: readonly number[] = DOWNLOAD_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !isChunkDownloadError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
