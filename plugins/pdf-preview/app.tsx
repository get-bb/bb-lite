import { useEffect, useState } from "react";
import {
  Icon,
  sidePanel,
  type FileViewerProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import { loadPdfBlob } from "./pdf-source";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; frameLoaded: boolean; url: string }
  | { status: "error"; message: string };

function Loading({ label, text }: { label: string; text: string }) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
      role="status"
      aria-label={label}
    >
      <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
      {text}
    </div>
  );
}

function PdfViewer({ path, url }: FileViewerProps) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void loadPdfBlob(url, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", frameLoaded: false, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [reloadNonce, url]);

  if (url === null || state.status === "error") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center" role="alert">
          <p className="text-sm text-destructive">
            Failed to load PDF:{" "}
            {url === null
              ? "this file has no address to load from."
              : state.status === "error" && state.message}
          </p>
          {url === null ? null : (
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setReloadNonce((current) => current + 1)}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      {state.status === "loading" ? (
        <Loading label={`Loading ${path}`} text="Loading PDF…" />
      ) : (
        <>
          {state.frameLoaded ? null : (
            <Loading label={`Rendering ${path}`} text="Rendering PDF…" />
          )}
          <iframe
            src={state.url}
            title={path}
            className="block h-full w-full border-0"
            onLoad={() =>
              setState((current) =>
                current.status === "ready"
                  ? { ...current, frameLoaded: true }
                  : current,
              )
            }
            onError={() =>
              setState({
                status: "error",
                message: "The browser could not open the PDF viewer.",
              })
            }
          />
        </>
      )}
    </div>
  );
}

export default function pdfPreviewApp(bb: PluginAppApi): void {
  bb.add(sidePanel.fileViewer, {
    id: "pdf",
    extensions: ["pdf"],
    view: PdfViewer,
  });
}
