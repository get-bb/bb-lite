import { fail } from "@bb/plugin";
import { parseFrontmatter, type PluginRunnerApi } from "@bb/runner";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { skillsMachine } from "./contract.js";

const SKILL_FILE = "SKILL.md";
const DISABLED = ".disabled";
const MAX_FILES = 500;
const CLONE_TIMEOUT_MS = 120_000;
const NAME = /^[A-Za-z0-9][\w.-]*$/u;
const run = promisify(execFile);

async function readSkill(directory: string, enabled: boolean) {
  const file = path.join(directory, SKILL_FILE);
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const description = parseFrontmatter(text).description || null;
  const name = path.basename(directory);
  return { name, description, path: file, enabled };
}

async function scanRoot(root: string, enabled = true) {
  const entries = await fs.readdir(root).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((entry) => entry !== DISABLED)
      .sort()
      .map((entry) => readSkill(path.join(root, entry), enabled)),
  );
  return found.filter((skill) => skill !== null);
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= MAX_FILES || entry.name === ".git") continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else files.push(child);
  }
  return files.slice(0, MAX_FILES);
}

async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

async function locate(checkout: string, skill: string | undefined) {
  const candidates =
    skill === undefined
      ? [checkout]
      : [".", "skills", ".agents/skills", ".claude/skills"].map((root) =>
          path.join(checkout, root, skill),
        );
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, SKILL_FILE))) return candidate;
  }
  return fail("invalid", `No ${SKILL_FILE} found in the source`, {
    hint: "Name the skill's directory inside the source",
  });
}

export default function skillsRunner(bb: PluginRunnerApi): void {
  const root = path.resolve(bb.dataDir, "..", "..", "skills");
  const disabledRoot = path.join(root, DISABLED);
  const where = (name: string, enabled: boolean) => {
    if (!NAME.test(name)) fail("invalid", `Invalid skill name: ${name}`);
    return path.join(enabled ? root : disabledRoot, name);
  };

  bb.implement(skillsMachine.installed, async () => ({
    root,
    skills: [
      ...(await scanRoot(root)),
      ...(await scanRoot(disabledRoot, false)),
    ],
  }));

  bb.implement(skillsMachine.scan, async ({ roots }) =>
    (await Promise.all(roots.map((entry) => scanRoot(entry)))).flat(),
  );

  bb.implement(skillsMachine.read, async (input) => {
    const content = await fs.readFile(input.path, "utf8").catch(() => null);
    if (content === null) return fail("not_found", "Skill file not found");
    return { content, files: await listFiles(path.dirname(input.path)) };
  });

  bb.implement(skillsMachine.install, async ({ source, skill }, { signal }) => {
    const local = await exists(path.resolve(source));
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "bb-skill-"));
    try {
      let checkout = path.resolve(source);
      if (!local) {
        checkout = path.join(scratch, "source");
        const args = ["clone", "--depth", "1", "--", source, checkout];
        await run("git", args, { signal, timeout: CLONE_TIMEOUT_MS }).catch(
          (error: unknown) =>
            fail("invalid", `git clone failed: ${String(error)}`),
        );
      }
      const directory = await locate(checkout, skill);
      const name = path.basename(directory);
      const target = where(name, true);
      if ((await exists(target)) || (await exists(where(name, false)))) {
        fail("conflict", `Skill ${name} is already installed`);
      }
      await fs.mkdir(root, { recursive: true });
      await fs.cp(directory, target, {
        recursive: true,
        filter: (file) => path.basename(file) !== ".git",
      });
      const installed = await readSkill(target, true);
      return installed ?? fail("invalid", `No ${SKILL_FILE} in ${name}`);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  bb.implement(skillsMachine.remove, async ({ name }) => {
    await fs.rm(where(name, true), { recursive: true, force: true });
    await fs.rm(where(name, false), { recursive: true, force: true });
    return null;
  });

  bb.implement(skillsMachine.toggle, async ({ name, enabled }) => {
    const target = where(name, enabled);
    const from = where(name, !enabled);
    if (await exists(from)) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(from, target);
    }
    const skill = await readSkill(target, enabled);
    return skill ?? fail("not_found", `Skill ${name} is not installed`);
  });
}
