const DIRECTIVE =
  /^\s*(@ts-|eslint-|oxlint-|v8 ignore|c8 ignore|@vitest-|#__PURE__|@__PURE__|\/ <reference|@jsx)/u;

const noComments = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
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

export default {
  meta: { name: "bb" },
  rules: { "no-comments": noComments },
};
