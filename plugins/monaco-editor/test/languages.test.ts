import { expect, it } from "vitest";
import { CLAIMED_EXTENSIONS, languageForPath } from "../languages.js";

it("leaves Markdown to bb's rendered preview but claims code and text", () => {
  expect(CLAIMED_EXTENSIONS).not.toContain("md");
  expect(CLAIMED_EXTENSIONS).not.toContain("markdown");
  expect(CLAIMED_EXTENSIONS).toEqual(
    expect.arrayContaining(["mdx", "ts", "json", "txt"]),
  );
});

it("picks a Monaco language from the file name", () => {
  expect(languageForPath("src/app.TSX")).toBe("typescript");
  expect(languageForPath("docs/guide.md")).toBe("markdown");
  expect(languageForPath("infra/main.tf")).toBe("hcl");
  expect(languageForPath(".gitignore")).toBe("plaintext");
  expect(languageForPath("Makefile")).toBe("plaintext");
  expect(languageForPath("archive.unknown")).toBe("plaintext");
});
