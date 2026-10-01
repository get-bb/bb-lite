import { lazy, Suspense } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import { Skeleton } from "@bb/shared-ui/skeleton";

const MarkdownHtml = lazy(() =>
  import("./markdown-html").then((module) => ({
    default: module.MarkdownHtml,
  })),
);

export function LazyMarkdownHtml(props: Options) {
  return (
    <Suspense
      fallback={
        <>
          <ReactMarkdown {...props} skipHtml />
          <Skeleton className="h-4 w-32" aria-label="Loading embedded HTML" />
        </>
      }
    >
      <MarkdownHtml {...props} />
    </Suspense>
  );
}
