import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPdfBlob } from "../pdf-source";

function stubFetch(response: Response) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("pdf-preview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a PDF from the address the side panel gives", async () => {
    const fetch = stubFetch(
      new Response("%PDF-1.7", {
        headers: { "content-type": "application/pdf; charset=binary" },
      }),
    );
    const blob = await loadPdfBlob(
      "/files/a.pdf",
      new AbortController().signal,
    );
    expect(await blob.text()).toBe("%PDF-1.7");
    expect(fetch).toHaveBeenCalledWith(
      "/files/a.pdf",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("refuses a response that is not a PDF", async () => {
    stubFetch(
      new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    await expect(
      loadPdfBlob("/files/a.pdf", new AbortController().signal),
    ).rejects.toThrow("The file response was not a PDF.");
  });

  it("reports a failed request with its status", async () => {
    stubFetch(new Response("missing", { status: 404 }));
    await expect(
      loadPdfBlob("/files/a.pdf", new AbortController().signal),
    ).rejects.toThrow("PDF request failed with status 404.");
  });
});
