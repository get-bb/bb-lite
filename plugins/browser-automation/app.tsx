import { useEffect, useState } from "react";
import {
  callOp,
  ImageLightbox,
  threadView,
  type MessageDirectiveProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import {
  browserAutomation as ba,
  PREVIEW_DIRECTIVE_ID,
  type PreviewFrame,
  type PreviewSize,
} from "./contract";

type Status = "connecting" | "live" | "ended" | "unavailable";

const LABEL: Record<Status, string> = {
  connecting: "Connecting",
  live: "Live",
  ended: "Ended",
  unavailable: "Unavailable",
};

const RETRY_MS = 250;

export function useLivePreview(
  threadId: string,
  sessionId: string,
  size: PreviewSize,
) {
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  useEffect(() => {
    if (sessionId === "") {
      setStatus("unavailable");
      return;
    }
    const abort = new AbortController();
    let after = 0;
    const pause = () => new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    void (async () => {
      while (!abort.signal.aborted) {
        const result = await callOp(
          ba.preview,
          { threadId, sessionId, afterSequence: after, size },
          { signal: abort.signal },
        ).catch(() => null);
        if (abort.signal.aborted) return;
        if (result === null || result.session.state !== "ready") {
          setStatus(result === null ? "unavailable" : "ended");
          return;
        }
        if (result.frame !== null) {
          after = result.frame.sequence;
          setFrame(result.frame);
          setStatus("live");
        }
        await pause();
      }
    })();
    return () => abort.abort();
  }, [threadId, sessionId, size]);
  return { frame, status };
}

const source = (frame: PreviewFrame) =>
  `data:${frame.mimeType};base64,${frame.data}`;

export function BrowserPreviewDirective({
  attributes,
  message,
}: MessageDirectiveProps) {
  const sessionId = attributes.session?.trim() ?? "";
  const [expanded, setExpanded] = useState(false);
  const { frame, status } = useLivePreview(
    message.threadId,
    sessionId,
    expanded ? "full" : "thumbnail",
  );
  const title = frame?.title || frame?.url || "Browser";
  return (
    <figure
      aria-label="Browser preview"
      className="my-2 w-full max-w-md overflow-hidden rounded-lg border border-border bg-muted/30"
    >
      <figcaption className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={frame?.url}>
          {title}
        </span>
        <span>{LABEL[status]}</span>
      </figcaption>
      {frame === null ? (
        <div
          aria-label="Loading browser preview"
          className="flex aspect-video items-center justify-center text-xs text-muted-foreground"
        >
          {status === "connecting" ? "Waiting for the page" : LABEL[status]}
        </div>
      ) : (
        <button
          type="button"
          aria-label="Expand browser preview"
          className="block w-full cursor-zoom-in"
          onClick={() => setExpanded(true)}
        >
          <img
            alt={`Browser preview: ${title}`}
            className="block w-full"
            src={source(frame)}
          />
        </button>
      )}
      <ImageLightbox
        isOpen={expanded && frame !== null}
        imageAlt={`Browser preview: ${title}`}
        imageSrc={frame === null ? null : source(frame)}
        title={title}
        onClose={() => setExpanded(false)}
      />
    </figure>
  );
}

export default function browserAutomationApp(bb: PluginAppApi): void {
  bb.add(threadView.messageDirective, {
    id: PREVIEW_DIRECTIVE_ID,
    view: BrowserPreviewDirective,
  });
}
