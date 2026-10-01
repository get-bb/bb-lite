import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/files/read.js";
import { createHarness, failureCode, type Harness } from "./harness.js";

describe("files", () => {
  let h: Harness;
  let root: string;

  beforeAll(() => {
    h = createHarness();
    root = path.join(h.root, "files");
    h.write(path.join(root, "notes.txt"), "first\n");
    h.write(path.join(h.root, "secret.txt"), "outside\n");
    fs.symlinkSync(path.join(h.root, "secret.txt"), path.join(root, "link"));
  });

  afterAll(() => h.dispose());

  it("reads with metadata and honours ifNoneMatch", async () => {
    const file = await h.api.readFile({ path: "notes.txt", rootPath: root });
    expect(file).toMatchObject({
      path: "notes.txt",
      content: "first\n",
      contentEncoding: "utf8",
      mimeType: "text/plain",
      sizeBytes: 6,
      sha256: sha256Hex("first\n"),
    });
    const cached = await h.api.readFile({
      path: path.join(root, "notes.txt"),
      ifNoneMatch: [file.sha256],
    });
    expect(cached).toMatchObject({ notModified: true, sha256: file.sha256 });
    expect("content" in cached).toBe(false);
    h.write(path.join(root, "pixel.png"), Buffer.from([137, 80, 78, 71]));
    const image = await h.api.readFile({ path: "pixel.png", rootPath: root });
    expect(image).toMatchObject({
      contentEncoding: "base64",
      mimeType: "image/png",
      content: "iVBORw==",
    });
  });

  it("confines reads and writes to the root", async () => {
    const attempts = [
      h.api.readFile({ path: "../secret.txt", rootPath: root }),
      h.api.readFile({ path: path.join(h.root, "secret.txt"), rootPath: root }),
      h.api.readFile({ path: "link", rootPath: root }),
      h.api.readFile({ path: "notes.txt" }),
      h.api.readFileChunk({
        path: "link",
        rootPath: root,
        offset: 0,
        length: 8,
        revision: null,
      }),
      h.api.writeFile({ path: "../escape.txt", rootPath: root, content: "x" }),
      h.api.writeFile({ path: "link/../../x", rootPath: root, content: "x" }),
      h.api.mutatePath({ op: "mkdir", path: "../made", rootPath: root }),
      h.api.mutatePath({ op: "remove", path: ".", rootPath: root }),
    ];
    const codes = await Promise.all(attempts.map(failureCode));
    expect(new Set(codes)).toEqual(new Set(["invalid_path"]));
    expect(fs.existsSync(path.join(h.root, "escape.txt"))).toBe(false);
    const missing = h.api.readFile({ path: "nope.txt", rootPath: root });
    expect(await failureCode(missing)).toBe("path_not_found");
  });

  it("writes with compare-and-set", async () => {
    const target = { path: "state/config.json", rootPath: root };
    const noParent = h.api.writeFile({ ...target, content: "{}" });
    expect(await failureCode(noParent)).toBe("path_not_found");
    const created = await h.api.writeFile({
      ...target,
      content: "{}",
      createParents: true,
      expectedSha256: null,
      mode: 0o600,
    });
    expect(created).toEqual({
      outcome: "written",
      sha256: sha256Hex("{}"),
      sizeBytes: 2,
    });
    const file = path.join(root, target.path);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const exists = await h.api.writeFile({
      ...target,
      content: "x",
      expectedSha256: null,
    });
    expect(exists).toEqual({
      outcome: "conflict",
      currentSha256: sha256Hex("{}"),
    });
    const stale = await h.api.writeFile({
      ...target,
      content: "x",
      expectedSha256: sha256Hex("old"),
    });
    expect(stale.outcome).toBe("conflict");
    const updated = await h.api.writeFile({
      ...target,
      content: '{"a":1}',
      expectedSha256: sha256Hex("{}"),
    });
    expect(updated.outcome).toBe("written");
    expect(fs.readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]);
    const tooLarge = h.api.writeFile({
      ...target,
      content: "x".repeat(513 * 1024),
    });
    expect(await failureCode(tooLarge)).toBe("file_too_large");
  });

  it("transfers large files in chunks and detects a change mid-read", async () => {
    const bytes = Buffer.alloc(700 * 1024, "ab");
    const target = { path: "upload/big.bin", rootPath: root };
    const half = 350 * 1024;
    for (const offset of [0, half]) {
      const dataBase64 = bytes
        .subarray(offset, offset + half)
        .toString("base64");
      const written = await h.api.writeFileChunk({
        ...target,
        offset,
        dataBase64,
        createParents: true,
      });
      expect(written.sizeBytes).toBe(offset + half);
    }
    const whole = h.api.readFile(target);
    expect(await failureCode(whole)).toBe("file_too_large");

    const first = await h.api.readFileChunk({
      ...target,
      offset: 0,
      length: half,
      revision: null,
    });
    expect(first).toMatchObject({ sizeBytes: bytes.length, offset: 0 });
    const rest = await h.api.readFileChunk({
      ...target,
      offset: half,
      length: half,
      revision: first.revision,
    });
    const received = Buffer.concat([
      Buffer.from(first.dataBase64, "base64"),
      Buffer.from(rest.dataBase64, "base64"),
    ]);
    expect(received.equals(bytes)).toBe(true);

    fs.appendFileSync(path.join(root, target.path), "changed");
    const stale = h.api.readFileChunk({
      ...target,
      offset: half,
      length: half,
      revision: first.revision,
    });
    expect(await failureCode(stale)).toBe("conflict");
    const oversized = h.api.readFileChunk({
      ...target,
      offset: 0,
      length: 600 * 1024,
      revision: null,
    });
    expect(await failureCode(oversized)).toBe("failed");
  });

  it("reads a file at a git revision", async () => {
    const repo = h.initRepo("history", { "src/a.txt": "committed\n" });
    h.write(path.join(repo, "src/a.txt"), "working\n");
    const target = { path: "src/a.txt", rootPath: repo, gitRef: "HEAD" };
    const old = await h.api.readFile(target);
    expect(old).toMatchObject({ content: "committed\n", sizeBytes: 10 });
    const chunk = await h.api.readFileChunk({
      ...target,
      offset: 3,
      length: 4,
      revision: null,
    });
    expect(Buffer.from(chunk.dataBase64, "base64").toString()).toBe("mitt");
    expect(chunk.sizeBytes).toBe(10);
    const absent = await h.api.readFile({ ...target, path: "src/none.txt" });
    expect(absent).toMatchObject({ content: "", sizeBytes: 0 });
    const badRef = h.api.readFile({ ...target, gitRef: "--output=x" });
    expect(await failureCode(badRef)).toBe("invalid_path");
  });

  it("lists paths ranked by the query and skips ignored files", async () => {
    const repo = h.initRepo("listing", {
      ".gitignore": "dist/\n*.log\n",
      "src/app.ts": "",
      "src/components/apple-pie.ts": "",
      "docs/guide.md": "",
      ".github/workflow.yml": "",
    });
    h.write(path.join(repo, "dist/app.js"), "");
    h.write(path.join(repo, "debug.log"), "");
    h.write(path.join(repo, "src/untracked-app.ts"), "");
    fs.rmSync(path.join(repo, "docs/guide.md"));
    const everything = { includeFiles: true, includeDirectories: true };
    const all = await h.api.listPaths({
      rootPath: repo,
      limit: 50,
      ...everything,
    });
    expect(all.paths.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "directory:src",
      "file:src/app.ts",
      "directory:src/components",
      "file:src/components/apple-pie.ts",
      "file:src/untracked-app.ts",
    ]);
    const ranked = await h.api.listPaths({
      rootPath: repo,
      query: "app",
      limit: 2,
      includeFiles: true,
      includeDirectories: false,
    });
    expect(ranked.truncated).toBe(true);
    expect(ranked.paths[0]).toMatchObject({
      kind: "file",
      path: "src/app.ts",
      name: "app.ts",
      positions: [4, 5, 6],
    });
    expect(ranked.paths[0]?.score).toBeGreaterThanOrEqual(
      ranked.paths[1]?.score ?? Infinity,
    );
    const hidden = await h.api.listPaths({
      rootPath: repo,
      query: "workflow",
      limit: 5,
      includeHidden: true,
      ...everything,
    });
    expect(hidden.paths[0]?.path).toBe(".github/workflow.yml");
    const plain = await h.api.listPaths({
      rootPath: root,
      limit: 50,
      ...everything,
    });
    expect(plain.paths.map((entry) => entry.path)).toContain("upload/big.bin");
    expect(plain.paths.map((entry) => entry.path)).not.toContain("link");
    const gone = await h.api.listPaths({
      rootPath: path.join(h.root, "absent"),
      limit: 5,
      ...everything,
    });
    expect(gone).toEqual({ paths: [], truncated: false });
  });

  it("lists commands and skills for the composer", async () => {
    const repo = h.initRepo("commands", {
      ".claude/commands/review.md": "---\ndescription: Review the diff\n---\n",
      ".claude/commands/team/sync.md": "no frontmatter\n",
      ".claude/skills/deploy/SKILL.md":
        '---\nname: deploy\ndescription: >\n  Ship it\n  safely\nargument-hint: "[env]"\n---\n',
      ".bb/skills/notes/SKILL.md": "---\ndescription: Take notes\n---\n",
    });
    const builtinDir = path.join(repo, ".bb", "skills");
    const { commands } = await h.api.listCommands({
      providerId: "claude-code",
      cwd: repo,
    });
    const project = commands.filter((command) => command.origin !== "user");
    expect(
      project.map((command) => `${command.source}:${command.name}`),
    ).toEqual([
      "command:clear",
      "command:compact",
      "skill:deploy",
      "skill:notes",
      "command:review",
      "command:team:sync",
    ]);
    expect(project[2]).toEqual({
      name: "deploy",
      source: "skill",
      origin: "project",
      description: "Ship it safely",
      argumentHint: "[env]",
    });
    expect(project[4]?.description).toBe("Review the diff");
    const dirs = await h.api.resolveSkillDirs({ cwd: repo, builtinDir });
    expect(dirs.skillDirs).toEqual([builtinDir, builtinDir]);
    const browsed = await h.api.browseDirectory({ path: repo });
    expect(browsed.parent).toBe(h.root);
    expect(browsed.entries).toEqual([]);
    const existence = await h.api.pathsExist({ paths: [repo, `${repo}/nope`] });
    expect(existence.existence).toEqual({
      [repo]: true,
      [`${repo}/nope`]: false,
    });
  });
});
