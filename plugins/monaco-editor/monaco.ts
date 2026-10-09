import * as monaco from "monaco-editor";

const SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
const MAX_OCCURRENCES = 1000;
const OVERFLOW_NODE_ID = "bb-plugin-monaco-editor-overflow-widgets";

Object.assign(globalThis, {
  MonacoEnvironment: {
    getWorker: (_: string, label: string) =>
      label === "editorWorkerService"
        ? new Worker(new URL("./worker.ts", import.meta.url), {
            type: "module",
          })
        : undefined,
  },
});

for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true });
}

for (const [name, base] of [
  ["bb-light", "vs"],
  ["bb-dark", "vs-dark"],
] as const) {
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#00000000",
      "editorGutter.background": "#00000000",
      "minimap.background": "#00000000",
    },
  });
}

monaco.languages.registerDocumentHighlightProvider(
  monaco.languages.getLanguages().map((entry) => entry.id),
  {
    provideDocumentHighlights(model, position) {
      const word = model.getWordAtPosition(position);
      if (word === null) return [];
      return model
        .findMatches(
          word.word,
          false,
          false,
          true,
          SEPARATORS,
          false,
          MAX_OCCURRENCES,
        )
        .map(({ range }) => ({
          range,
          kind: monaco.languages.DocumentHighlightKind.Text,
        }));
    },
  },
);

export function overflowWidgetsNode(dark: boolean): HTMLElement {
  const node =
    document.getElementById(OVERFLOW_NODE_ID) ?? document.createElement("div");
  if (!node.isConnected) {
    node.id = OVERFLOW_NODE_ID;
    Object.assign(node.style, {
      position: "absolute",
      top: "0",
      left: "0",
      zIndex: "40",
    });
    document.body.appendChild(node);
  }
  node.className = `monaco-editor ${dark ? "vs-dark" : "vs"}`;
  return node;
}

export { monaco };
