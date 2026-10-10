import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { expect, it } from "vitest";
import { promptHighlights } from "../../../plugins/composer/app/components/promptbox/editor/prompt-decoration-extension";

it("paints the ranges a plugin's text effect matches, at draft offsets", () => {
  const schema = getSchema([Document, Paragraph, Text]);
  const paragraph = (text: string) =>
    schema.node("paragraph", null, [schema.text(text)]);
  const doc = schema.node("doc", null, [
    paragraph("/plan the work"),
    paragraph("then /plan again"),
  ]);
  const seen: number[] = [];
  const command = {
    id: "command",
    className: "slash",
    match(text: string, { offset }: { offset: number }) {
      seen.push(offset);
      const found = offset === 0 ? /^\/\w+/u.exec(text) : null;
      return found === null ? [] : [{ from: 0, to: found[0].length }];
    },
  };
  const wild = {
    id: "wild",
    className: "x",
    match: () => [{ from: 3, to: 99 }],
  };
  const highlights = promptHighlights(doc, [command, wild]);
  expect(highlights).toEqual([{ from: 1, to: 6, className: "slash" }]);
  expect(seen).toEqual([0, 15]);
  const ultra = schema.node("doc", null, [paragraph("go ultracode now")]);
  expect(promptHighlights(ultra, [])).toEqual([
    { from: 4, to: 13, className: "prompt-ultracode-highlight" },
  ]);
});
