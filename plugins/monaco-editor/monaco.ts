import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/common/standaloneStrings.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/languages/definitions/bat/register.js";
import "monaco-editor/languages/definitions/clojure/register.js";
import "monaco-editor/languages/definitions/cpp/register.js";
import "monaco-editor/languages/definitions/csharp/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/dart/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/fsharp/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/graphql/register.js";
import "monaco-editor/languages/definitions/hcl/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/ini/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/julia/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/less/register.js";
import "monaco-editor/languages/definitions/lua/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/perl/register.js";
import "monaco-editor/languages/definitions/php/register.js";
import "monaco-editor/languages/definitions/powershell/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/r/register.js";
import "monaco-editor/languages/definitions/ruby/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/scala/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/swift/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { monacoThemeFor } from "./theme";

const SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
const MAX_OCCURRENCES = 1000;
const OVERFLOW_NODE_ID = "bb-plugin-monaco-editor-overflow-widgets";

Object.assign(globalThis, {
  MonacoEnvironment: {
    getWorker: () =>
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  },
});

monaco.languages.register({
  id: "json",
  extensions: [".json", ".jsonc"],
  aliases: ["JSON", "json"],
});
monaco.languages.setLanguageConfiguration("json", {
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
});
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/u, "type"],
      [/"(?:[^"\\]|\\.)*"/u, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u, "number"],
      [/\b(?:true|false|null)\b/u, "keyword"],
      [/\/\/.*$/u, "comment"],
      [/\/\*[\s\S]*?\*\//u, "comment"],
      [/[{}[\],:]/u, "delimiter"],
    ],
  },
});

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

let themed = false;

export function applyCodeTheme(dark: boolean, data: unknown): void {
  monaco.editor.defineTheme("bb-code", monacoThemeFor(dark, data));
  monaco.editor.setTheme("bb-code");
  themed = true;
}

export function ensureCodeTheme(dark: boolean): void {
  if (!themed) applyCodeTheme(dark, null);
}

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
