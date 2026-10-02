import { highlight, type LanguageName } from "sugar-high";
import { lang } from "sugar-high/lang";

const EXTRA_LANGUAGE_ALIASES: Record<string, LanguageName> = {
  console: "shell",
  shellscript: "shell",
  h: "c",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  less: "css",
};

export function highlightMarkdownCode(
  code: string,
  language: string | null,
): string {
  return highlight(code, {
    lang:
      language === null
        ? undefined
        : (lang(language) ?? EXTRA_LANGUAGE_ALIASES[language]),
  });
}
