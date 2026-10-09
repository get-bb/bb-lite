import { expect, it } from "vitest";
import { summarize } from "../extras.js";

it("takes a document's title from its heading and previews the rest", () => {
  const content =
    "---\ntags: [a]\n---\nIntro line\n# Launch Plan\n\n- Ship *it*\n";
  expect(summarize(content)).toEqual({
    title: "Launch Plan",
    preview: "Intro line Ship it",
  });
  expect(summarize("plain first line\nsecond")).toEqual({
    title: "plain first line",
    preview: "second",
  });
});
