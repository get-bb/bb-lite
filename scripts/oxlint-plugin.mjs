import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTIVE =
  /^\s*(@ts-|eslint-|oxlint-|v8 ignore|c8 ignore|@vitest-|#__PURE__|@__PURE__|\/ <reference|@jsx)/u;

const noComments = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang") continue;
          if (DIRECTIVE.test(comment.value)) continue;
          context.report({
            loc: comment.loc,
            message: "Explain through names and structure, not comments.",
          });
        }
      },
    };
  },
};

const PLUGINS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
);
const CONTRACT_FILE = /(^|[\\/])contracts?(\.[cm]?[jt]sx?)?$/u;
const PRIVATE_PACKAGES = ["@bb/server", "@bb/profile-default", "@bb/cli"];
const OTHER_PLUGIN = /^bb-plugin-[a-z0-9-]+\//u;
const CONTRACT_SPECIFIER = /^bb-plugin-[a-z0-9-]+\/contract(\.js)?$/u;
const REASON =
  "A plugin may import its own files, libraries, @bb/plugin and another " +
  "plugin's contract. It may not reach into apps/ or another plugin.";

function pluginImportProblem(filename, specifier) {
  const [pluginId, ...rest] = relative(PLUGINS_ROOT, filename).split(sep);
  if (pluginId === undefined || pluginId === ".." || rest.length === 0) {
    return null;
  }
  if (rest.includes("test")) return null;
  const root = `${PLUGINS_ROOT}${sep}`;
  if (specifier.startsWith("@/")) return REASON;
  const reserved = PRIVATE_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
  if (reserved) return REASON;
  if (OTHER_PLUGIN.test(specifier)) {
    return CONTRACT_SPECIFIER.test(specifier) ? null : REASON;
  }
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(filename), specifier);
  const own = `${root}${pluginId}${sep}`;
  if (target.startsWith(own)) return null;
  const other = target.startsWith(root) && CONTRACT_FILE.test(target);
  return other ? null : REASON;
}

const pluginImports = {
  create(context) {
    const check = (node) => {
      const specifier = node?.value;
      if (typeof specifier !== "string") return;
      const message = pluginImportProblem(context.filename, specifier);
      if (message !== null) context.report({ node, message });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
};

export default {
  meta: { name: "bb" },
  rules: { "no-comments": noComments, "plugin-imports": pluginImports },
};
