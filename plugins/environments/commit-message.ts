import { environments, type PluginServerApi } from "@bb/plugin";
import { canInfer, infer } from "@bb/server-kit/providers/inference";

const MAX_PATCH_CHARS = 32_000;
const MAX_FILE_LIST_CHARS = 4_000;
const MAX_COLUMNS = 72;
const TIMEOUT_MS = 8_000;
const PROMPT = `Write a concise git commit message for uncommitted changes.
Reply with only the commit message line, without quotes or explanation.
Rules:
- Use conventional commit style (feat|fix|refactor|test|docs|chore|perf|build|ci|style).
- Prefer specific types like feat/fix/refactor/test/docs/perf over chore.
- Use chore only for housekeeping (deps, tooling, CI, formatting, repo maintenance).
- Use imperative mood, max 72 characters.
- Single line only, no body.`;

export function cleanCommitMessage(reply: string): string | null {
  const line = reply
    .split(/\r?\n/u)
    .map((part) =>
      part
        .trim()
        .replace(/^(["'`])(.*)\1$/u, "$2")
        .trim(),
    )
    .find((part) => part !== "" && !part.startsWith("```"));
  if (line === undefined) return null;
  const message = line.replace(/\s+/gu, " ");
  if (message.length <= MAX_COLUMNS) return message;
  const space = message.lastIndexOf(" ", MAX_COLUMNS);
  return message.slice(0, space > 0 ? space : MAX_COLUMNS).trim();
}

export async function inferCommitMessage(
  bb: PluginServerApi,
  environmentId: string,
  caller?: AbortSignal,
): Promise<string | null> {
  if (!canInfer(bb)) return null;
  const diff = await bb.call(environments.diffFiles, {
    environmentId,
    target: "uncommitted",
  });
  if (diff.outcome !== "available" || diff.files.length === 0) return null;
  const files = diff.files
    .map((file) => `${file.changeKind}\t${file.path}`)
    .join("\n")
    .slice(0, MAX_FILE_LIST_CHARS);
  const patch = diff.initialPatches
    .map((entry) => entry.patch)
    .join("\n")
    .slice(0, MAX_PATCH_CHARS);
  const prompt = [
    PROMPT,
    `Shortstat:\n${diff.shortstat}`,
    `Files (name-status):\n${files}`,
    `Patch excerpt:\n${patch}`,
  ].join("\n\n");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  const reply = await infer(bb, { prompt, maxTokens: 100 }, signal);
  return reply === null ? null : cleanCommitMessage(reply);
}
