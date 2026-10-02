const UNTERMINATED_QUOTE =
  /^\s*(?:export\s+)?[A-Za-z_]\w*\s*=\s*(?:'[^']*|"(?:[^"\\]|\\.?)*)$/u;
const TRAILING_COMMENT =
  /^(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^'"\s]|\s+(?![\s#]))*(\s+#.*)?$/u;

function assignmentPattern(name: string): RegExp {
  return new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=\\s*)(.*)$`, "u");
}

export function assertReconcilable(content: string, names: string[]): void {
  const lines = content.split(/\r?\n/u);
  if (lines.some((line) => UNTERMINATED_QUOTE.test(line))) {
    throw new Error("Dotenv files with multiline values are not supported.");
  }
  for (const name of names) {
    const pattern = assignmentPattern(name);
    if (lines.filter((line) => pattern.test(line)).length > 1) {
      throw new Error(`The dotenv file assigns ${name} more than once.`);
    }
  }
}

function encodeValue(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/u.test(value)) return `"${value}"`;
  if (value === value.trim() && !value.includes("#")) return value;
  throw new Error("A secret cannot be written as one dotenv assignment.");
}

export function reconcileDotenv(
  content: string,
  values: Readonly<Record<string, string>>,
) {
  const names = Object.keys(values);
  assertReconcilable(content, names);
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const endedWithNewline = content.endsWith("\n");
  const lines = content === "" ? [] : content.split(/\r?\n/u);
  if (endedWithNewline) lines.pop();
  const counts = { added: 0, updated: 0, unchanged: 0 };
  const missing = new Set(names);
  const next = lines.map((line) => {
    for (const name of names) {
      const [, prefix, rest] = assignmentPattern(name).exec(line) ?? [];
      if (prefix === undefined || rest === undefined) continue;
      missing.delete(name);
      const comment = TRAILING_COMMENT.exec(rest)?.[1] ?? "";
      const replaced = `${prefix}${encodeValue(values[name] ?? "")}${comment}`;
      counts[replaced === line ? "unchanged" : "updated"] += 1;
      return replaced;
    }
    return line;
  });
  for (const name of missing) {
    next.push(`${name}=${encodeValue(values[name] ?? "")}`);
    counts.added += 1;
  }
  const joined = next.join(lineEnding);
  const terminator = endedWithNewline || counts.added > 0 ? lineEnding : "";
  return { content: joined === "" ? "" : joined + terminator, ...counts };
}
