import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Icon,
  shell,
  sidePanel,
  useBbContext,
  useCall,
  useOp,
  type FileViewerProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import { usePreferredTheme } from "@bb/app-kit/hooks/useTheme";
import { Button } from "@bb/shared-ui/button";
import { monacoEditor } from "./contract";
import { CLAIMED_EXTENSIONS, languageForPath } from "./languages";

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
}

let loading: Promise<MonacoModule> | null = null;
const loadMonaco = () => (loading ??= import("./monaco"));
let active: { editor: CodeEditor; path: string } | null = null;

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

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function MonacoFileViewer({ path, content }: FileViewerProps) {
  const { threadId } = useBbContext();
  const file = useOp(
    monacoEditor.read,
    { threadId: threadId ?? "", path },
    { enabled: threadId !== null },
  );
  const [reloads, setReloads] = useState(0);
  if (threadId === null) {
    return content === null ? (
      <Centered>This file has no text to show.</Centered>
    ) : (
      <Editor
        path={path}
        threadId={null}
        loaded={{ content, sha256: null }}
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
  loaded: Loaded;
  onReload(): void;
}

function Editor({ path, threadId, loaded, onReload }: EditorProps) {
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
  const write = useCall(monacoEditor.write);
  const readOnly = threadId === null;

  saveRef.current = async (force) => {
    const editor = editorRef.current;
    if (editor === null || threadId === null) return;
    const content = editor.getValue();
    setState({ kind: "saving" });
    try {
      const result = await write({
        threadId,
        path,
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
      ({ monaco, overflowWidgetsNode }) => {
        if (disposed || host.current === null) return;
        sha.current = loaded.sha256;
        setDirty(false);
        const opened = monaco.editor.create(host.current, {
          value: loaded.content,
          language: languageForPath(path),
          theme: darkRef.current ? "bb-dark" : "bb-light",
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
        opened.onDidFocusEditorText(() => {
          active = { editor: opened, path };
        });
        active = { editor: opened, path };
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
    void loadMonaco().then(({ monaco, overflowWidgetsNode }) => {
      monaco.editor.setTheme(dark ? "bb-dark" : "bb-light");
      overflowWidgetsNode(dark);
    });
  }, [dark]);

  if (failed !== null) {
    return <Centered>Failed to load the editor: {failed}</Centered>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
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
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
}

export default function monacoEditorApp(bb: PluginAppApi): void {
  bb.add(sidePanel.fileViewer, {
    id: "monaco",
    extensions: CLAIMED_EXTENSIONS,
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
  bb.add(shell.command, {
    id: "copy-path",
    title: "Monaco: copy path of current file",
    isAvailable: () => active !== null,
    run: () => navigator.clipboard.writeText(active?.path ?? ""),
  });
}
