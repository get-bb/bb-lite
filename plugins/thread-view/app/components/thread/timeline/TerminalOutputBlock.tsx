import { useMemo } from "react";
import Convert from "ansi-to-html";
import { cn } from "@bb/shared-ui/lib/utils";
import { getDetailScrollMaxHeightClass } from "../../ui/detail-scroll-size";
import { TimelineDetailScroll } from "./TimelineDetailScroll";

interface TerminalOutputBlockProps {
  output: string;
  commandLine: string;
  exitCode: number | null;
  metadataLines: readonly string[];
  streaming: boolean;
}

const ANSI_COLOR_INDEXES = Array.from({ length: 16 }, (_, index) => index);
const BACKGROUND_RESET_STYLE = "background-color:var(--background)";

function addBackgroundContrastColors(html: string): string {
  let out = html;
  for (const colorIndex of ANSI_COLOR_INDEXES) {
    const backgroundStyle = `background-color:var(--ansi-${colorIndex})`;
    out = out.replaceAll(
      backgroundStyle,
      `${backgroundStyle};color:var(--ansi-bg-fg-${colorIndex})`,
    );
  }
  return out.replaceAll(
    BACKGROUND_RESET_STYLE,
    `${BACKGROUND_RESET_STYLE};color:var(--foreground)`,
  );
}

const ANSI_TO_HTML = new Convert({
  escapeXML: true,
  newline: false,
  stream: false,
  fg: "var(--muted-foreground)",
  bg: "var(--background)",
  colors: Object.fromEntries(
    ANSI_COLOR_INDEXES.map((index) => [index, `var(--ansi-${index})`]),
  ),
});

export function TerminalOutputBlock({
  commandLine,
  exitCode,
  metadataLines,
  output,
  streaming,
}: TerminalOutputBlockProps) {
  const renderedOutputHtml = useMemo(
    () =>
      output.length > 0
        ? addBackgroundContrastColors(ANSI_TO_HTML.toHtml(output))
        : null,
    [output],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="px-4 py-3 font-mono text-xs leading-tight text-foreground opacity-70">
        {commandLine ? (
          <div
            className={cn(
              "overflow-auto whitespace-pre-wrap break-words",
              getDetailScrollMaxHeightClass("base"),
            )}
          >
            {commandLine}
          </div>
        ) : null}
        {metadataLines.map((line, index) => (
          <div key={`${index}:${line}`} className="mt-1 text-muted-foreground">
            {line}
          </div>
        ))}
        {renderedOutputHtml ? (
          <TimelineDetailScroll
            size="base"
            streaming={streaming}
            contentKey={`${output.length}:${exitCode ?? ""}`}
            className="mt-1.5"
            scrollClassName="whitespace-pre leading-tight text-muted-foreground"
          >
            <div dangerouslySetInnerHTML={{ __html: renderedOutputHtml }} />
          </TimelineDetailScroll>
        ) : null}
        {exitCode !== null ? (
          <div className="mt-1.5 font-mono text-xs leading-tight text-muted-foreground">
            exit code {exitCode}
          </div>
        ) : null}
      </div>
    </div>
  );
}
