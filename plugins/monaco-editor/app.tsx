import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Icon,
  shell,
  sidePanel,
  useCall,
  useCodeTheme,
  useOp,
  type FileViewerProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import { usePreferredTheme } from "@bb/app-kit/hooks/useTheme";
import { copyToClipboardWithToast } from "@bb/app-kit/lib/clipboard";
import { Button } from "@bb/shared-ui/button";
import { monacoEditor } from "./contract";
import { FileTree } from "./FileTree";
import {
  CLAIMED_EXTENSIONS,
  CLAIMED_NAMES,
  languageForPath,
} from "./languages";

type MonacoModule = typeof import("./monaco");
type CodeEditor = ReturnType<MonacoModule["monaco"]["editor"]["create"]>;
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };
interface Loaded {
  content: string;
  sha256: string | null;
  absolutePath: string;
  relativePath: string;
}
interface Active {
  editor: CodeEditor;
  absolutePath: string;
  relativePath: string;
}

let loading: Promise<MonacoModule> | null = null;
const loadMonaco = () => (loading ??= import("./monaco"));
let active: Active | null = null;
let treeShown = true;

const EDITOR_ACTIONS: readonly [string, string, string][] = [
  ...[1, 2, 3, 4, 5].map((level): [string, string, string] => [
    `fold-level-${level}`,
    `Monaco: fold level ${level}`,
    `editor.foldLevel${level}`,
  ]),
  ["fold-recursively", "Monaco: fold recursively", "editor.foldRecursively"],
  ["unfold-all", "Monaco: unfold all", "editor.unfoldAll"],
  [
    "unfold-recursively",
    "Monaco: unfold recursively",
    "editor.unfoldRecursively",
  ],
  ["unfold", "Monaco: unfold at cursor", "editor.unfold"],
  [
    "sort-lines-ascending",
    "Monaco: sort selected lines ascending",
    "editor.action.sortLinesAscending",
  ],
  [
    "sort-lines-descending",
    "Monaco: sort selected lines descending",
    "editor.action.sortLinesDescending",
  ],
];

const COPY_COMMANDS = [
  [
    "copy-path",
    "Monaco: copy path of current file",
    "absolutePath",
    "Absolute path copied",
  ],
  [
    "copy-relative-path",
    "Monaco: copy relative path of current file",
    "relativePath",
    "Relative path copied",
  ],
] as const;

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function MonacoFileViewer({
  path,
  threadId,
  source,
  projectId,
  hostId,
  content,
}: FileViewerProps) {
  const checkout = source === "workspace" && projectId !== null;
  const readable = threadId !== null || source === "host" || checkout;
  const place = { projectId, hostId };
  const file = useOp(
    monacoEditor.read,
    { threadId, source, path, ...place },
    { enabled: readable },
  );
  const [reloads, setReloads] = useState(0);
  if (!readable) {
    return content === null ? (
      <Centered>This file has no text to show.</Centered>
    ) : (
      <Editor
        path={path}
        threadId={null}
        source={source}
        place={place}
        loaded={{
          content,
          sha256: null,
          absolutePath: path,
          relativePath: path,
        }}
        onReload={() => undefined}
      />
    );
  }
  if (file.status === "error") {
    return <Centered>Failed to open {path}.</Centered>;
  }
  if (file.data === undefined) {
    return (
      <Centered>
        <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
        Opening {path}…
      </Centered>
    );
  }
  if (file.data.kind === "unsupported") {
    return <Centered>{file.data.reason}</Centered>;
  }
  return (
    <Editor
      key={`${path}:${reloads}`}
      path={path}
      threadId={threadId}
      source={source}
      place={place}
      loaded={file.data}
      onReload={() => {
        void file.refetch();
        setReloads((count) => count + 1);
      }}
    />
  );
}

interface EditorProps {
  path: string;
  threadId: string | null;
  source: FileViewerProps["source"];
  place: Pick<FileViewerProps, "projectId" | "hostId">;
  loaded: Loaded;
  onReload(): void;
}

function Editor({
  path,
  threadId,
  source,
  place,
  loaded,
  onReload,
}: EditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CodeEditor | null>(null);
  const sha = useRef(loaded.sha256);
  const saveRef = useRef<(force: boolean) => Promise<void>>(async () => {});
  const [failed, setFailed] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const dark = usePreferredTheme() === "dark";
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const paths = useRef(loaded);
  paths.current = loaded;
  const codeTheme = useCodeTheme();
  const [showTree, setShowTree] = useState(treeShown);
  const write = useCall(monacoEditor.write);
  const readOnly = loaded.sha256 === null;

  saveRef.current = async (force) => {
    const editor = editorRef.current;
    if (editor === null || readOnly) return;
    const content = editor.getValue();
    setState({ kind: "saving" });
    try {
      const result = await write({
        threadId,
        source,
        path,
        ...place,
        content,
        ...(force ? {} : { expectedSha256: sha.current }),
      });
      if (result.outcome === "conflict") {
        setState({ kind: "conflict" });
        return;
      }
      sha.current = result.sha256;
      setDirty(editor.getValue() !== content);
      setState({ kind: "idle" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({ kind: "error", message });
    }
  };

  useEffect(() => {
    let disposed = false;
    let editor: CodeEditor | null = null;
    loadMonaco().then(
      ({ monaco, overflowWidgetsNode, ensureCodeTheme }) => {
        if (disposed || host.current === null) return;
        ensureCodeTheme(darkRef.current);
        sha.current = loaded.sha256;
        setDirty(false);
        const opened = monaco.editor.create(host.current, {
          value: loaded.content,
          language: languageForPath(path),
          theme: "bb-code",
          readOnly,
          automaticLayout: true,
          fixedOverflowWidgets: true,
          overflowWidgetsDomNode: overflowWidgetsNode(darkRef.current),
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
        });
        opened.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void saveRef.current(false);
        });
        const initial = opened.getModel()?.getAlternativeVersionId();
        opened.onDidChangeModelContent(() => {
          setDirty(opened.getModel()?.getAlternativeVersionId() !== initial);
        });
        const focused = {
          editor: opened,
          absolutePath: paths.current.absolutePath,
          relativePath: paths.current.relativePath,
        };
        opened.onDidFocusEditorText(() => {
          active = focused;
        });
        active = focused;
        editor = opened;
        editorRef.current = opened;
      },
      (error: unknown) => {
        if (!disposed) setFailed(String(error));
      },
    );
    return () => {
      disposed = true;
      if (active?.editor === editor) active = null;
      editor?.getModel()?.dispose();
      editor?.dispose();
      editorRef.current = null;
    };
  }, [path, loaded.content, loaded.sha256, readOnly]);

  useEffect(() => {
    let current = true;
    void loadMonaco().then((loaded) => {
      if (!current) return;
      loaded.applyCodeTheme(dark, codeTheme);
      loaded.overflowWidgetsNode(dark);
    });
    return () => {
      current = false;
    };
  }, [dark, codeTheme]);

  if (failed !== null) {
    return <Centered>Failed to load the editor: {failed}</Centered>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
        {threadId === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={showTree ? "Hide files" : "Show files"}
            aria-pressed={showTree}
            onClick={() => {
              treeShown = !showTree;
              setShowTree(treeShown);
            }}
          >
            <Icon name="Folder" className="size-4" aria-hidden />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {path}
          {dirty ? " •" : ""}
        </span>
        {readOnly ? (
          <span className="text-xs text-muted-foreground">Read-only</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || state.kind === "saving"}
            onClick={() => void saveRef.current(false)}
          >
            {state.kind === "saving" ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {state.kind === "conflict" ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-1 text-sm"
        >
          <span className="flex-1">This file changed on disk.</span>
          <Button variant="ghost" size="sm" onClick={onReload}>
            Reload
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void saveRef.current(true)}
          >
            Overwrite
          </Button>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div
          role="alert"
          className="shrink-0 border-b border-border px-3 py-1 text-sm text-destructive"
        >
          Failed to save: {state.message}
        </div>
      ) : null}
      {showTree && threadId !== null ? (
        <FileTree
          threadId={threadId}
          source={source}
          path={path}
          activePath={loaded.relativePath}
        />
      ) : null}
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
}

export default function monacoEditorApp(bb: PluginAppApi): void {
  bb.add(sidePanel.fileViewer, {
    id: "monaco",
    extensions: CLAIMED_EXTENSIONS,
    names: CLAIMED_NAMES,
    view: MonacoFileViewer,
  });
  for (const [id, title, action] of EDITOR_ACTIONS) {
    bb.add(shell.command, {
      id,
      title,
      isAvailable: () => active !== null,
      run: () => active?.editor.getAction(action)?.run(),
    });
  }
  for (const [id, title, key, message] of COPY_COMMANDS) {
    bb.add(shell.command, {
      id,
      title,
      isAvailable: () => active !== null,
      run: () =>
        active === null
          ? undefined
          : void copyToClipboardWithToast(active[key], {
              successMessage: message,
            }),
    });
  }
}
