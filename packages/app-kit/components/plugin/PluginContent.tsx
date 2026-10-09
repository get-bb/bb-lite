import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import {
  files,
  type DiffProps,
  type FileLinkProps,
  type MarkdownProps,
} from "@bb/plugin/app";
import { GitDiffCard } from "../git-diff/GitDiffCard";
import { FilePathLink } from "../ui/file-path-link";
import { MarkdownPreview } from "../ui/markdown-preview";
import { requestFileOpen } from "../../lib/file-open-requests";
import { buildEnvironmentFileContentUrl } from "../../lib/file-content-urls";
import {
  defaultFileSource,
  markdownDocumentRouting,
  unifiedPatch,
} from "../../lib/plugin-content";
import { useAppNavigationHost } from "../../lib/url-open-routing";
import { callOp } from "../../plugins/registry";

const PRESENTATION = {
  view: "unified",
  overflow: "scroll",
  showLineNumbers: true,
} as const;

export function PluginMarkdown({ document, ...props }: MarkdownProps) {
  const threadId = document?.threadId ?? "";
  const path = document?.path ?? "";
  const source = defaultFileSource(path, document?.source);
  const served = useQuery({
    queryKey: ["plugin-markdown-document", threadId, path, source],
    queryFn: () => callOp(files.url, { threadId, path, source }),
    enabled: document !== undefined,
    staleTime: Infinity,
  });
  const url = served.data?.url;
  const linkRouting = useMemo(
    () =>
      url === undefined
        ? undefined
        : markdownDocumentRouting({
            path,
            url,
            open: (target) => requestFileOpen(threadId, target, source),
          }),
    [path, source, threadId, url],
  );
  return <MarkdownPreview {...props} linkRouting={linkRouting} />;
}

export function PluginDiff({ patch, path }: DiffProps) {
  const parsed = useMemo(() => {
    try {
      return parsePatchFiles(unifiedPatch(patch, path)).flatMap(
        (entry) => entry.files,
      );
    } catch {
      return [];
    }
  }, [patch, path]);
  if (parsed.length === 0) {
    return (
      <pre className="overflow-x-auto px-2 py-1 font-mono text-xs">{patch}</pre>
    );
  }
  return (
    <>
      {parsed.map((fileDiff, index) => (
        <GitDiffCard
          key={index}
          fileDiff={fileDiff}
          patchText={
            parsed.length === 1 ? unifiedPatch(patch, path) : undefined
          }
          presentation={PRESENTATION}
          cardClassName="rounded-none border-0 bg-transparent"
          showStuckHeaderEdge={false}
        />
      ))}
    </>
  );
}

export function PluginFileLink({
  path,
  threadId,
  environmentId,
  children,
}: FileLinkProps) {
  const navigation = useAppNavigationHost();
  const open = () => {
    if (threadId !== undefined && requestFileOpen(threadId, path)) return;
    if (environmentId === undefined) return;
    const source = { kind: "working-tree" } as const;
    const url = buildEnvironmentFileContentUrl(environmentId, source, path);
    navigation.openUrl({ url });
  };
  const openable = threadId !== undefined || environmentId !== undefined;
  if (children === undefined) {
    return <FilePathLink path={path} onClick={openable ? open : undefined} />;
  }
  return (
    <button
      type="button"
      title={path}
      className="underline-offset-2 hover:underline"
      onClick={open}
      disabled={!openable}
    >
      {children}
    </button>
  );
}
