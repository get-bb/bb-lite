import type { Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";

function dispatch(editor: Editor, transaction: Transaction | null): boolean {
  if (transaction === null) return false;
  editor.view.dispatch(transaction);
  return true;
}

function blockquoteDepth($from: ResolvedPos): number | null {
  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "blockquote") return depth;
  }
  return null;
}

function paragraphCursor(editor: Editor) {
  const { selection, schema } = editor.state;
  const paragraphType = schema.nodes.paragraph;
  if (!selection.empty || !paragraphType) return null;
  const { $from } = selection;
  if ($from.parent.type !== paragraphType) return null;
  return { $from, paragraphType, quoteDepth: blockquoteDepth($from) };
}

function insertParagraphAt(transaction: Transaction, position: number) {
  return transaction
    .setSelection(TextSelection.create(transaction.doc, position + 1))
    .scrollIntoView();
}

export function applyPromptParagraphNewline(editor: Editor): boolean {
  const cursor = paragraphCursor(editor);
  if (cursor === null || cursor.$from.depth !== 1) return false;
  return editor.commands.splitBlock({ keepMarks: false });
}

export function insertParagraphBeforeBlockquote(editor: Editor): boolean {
  const cursor = paragraphCursor(editor);
  if (cursor === null || cursor.quoteDepth === null) return false;
  const { $from, paragraphType, quoteDepth } = cursor;
  if ($from.parentOffset !== 0 || $from.index(quoteDepth) !== 0) return false;
  const insertAt = $from.before(quoteDepth);
  return dispatch(
    editor,
    insertParagraphAt(
      editor.state.tr.insert(insertAt, paragraphType.create()),
      insertAt,
    ),
  );
}

export function exitTrailingBlockquoteBreak(editor: Editor): boolean {
  const cursor = paragraphCursor(editor);
  if (cursor === null || cursor.quoteDepth === null) return false;
  const { $from, paragraphType, quoteDepth } = cursor;
  const nodeBefore = $from.nodeBefore;
  if (
    $from.parentOffset !== $from.parent.content.size ||
    nodeBefore?.type.name !== "hardBreak" ||
    $from.after($from.depth) !== $from.end(quoteDepth)
  ) {
    return false;
  }
  const transaction = editor.state.tr.delete(
    $from.pos - nodeBefore.nodeSize,
    $from.pos,
  );
  const insertAt = transaction.mapping.map($from.after(quoteDepth));
  return dispatch(
    editor,
    insertParagraphAt(
      transaction.insert(insertAt, paragraphType.create()),
      insertAt,
    ),
  );
}

export function removeEmptyBlockquotes(editor: Editor): boolean {
  const { state } = editor;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;
  const ranges: Array<{ from: number; to: number }> = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === "blockquote" && node.textContent.length === 0) {
      ranges.push({ from: pos, to: pos + node.nodeSize });
    }
  });
  let transaction = state.tr;
  for (const range of ranges.reverse()) {
    const from = transaction.mapping.map(range.from);
    const to = transaction.mapping.map(range.to);
    transaction =
      from === 0 && to === transaction.doc.content.size
        ? transaction.replaceWith(from, to, paragraphType.create())
        : transaction.delete(from, to);
  }
  return dispatch(
    editor,
    transaction.docChanged ? transaction.scrollIntoView() : null,
  );
}
