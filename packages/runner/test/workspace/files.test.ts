import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/files/read.js";
import { createHarness, failureCode, type Harness } from "./harness.js";

const KIB = 1024;

describe("files", () => {
  let h: Harness;
  let root: string;

  beforeAll(() => {
    h = createHarness();
    root = path.join(h.root, "files");
    h.write(h.root, {
      "files/notes.txt": "first\n",
      "secret.txt": "outside\n",
    });
    fs.symlinkSync(path.join(h.root, "secret.txt"), path.join(root, "link"));
    fs.symlinkSync(path.join(h.root, "created"), path.join(root, "dangling"));
  });

  afterAll(() => h.dispose());

  it("reads with metadata, at a git revision, and only inside the root", async () => {
    const file = await h.api.readFile({ path: "notes.txt", rootPath: root });
    const sha256 = sha256Hex("first\n");
    const text = { contentEncoding: "utf8", mimeType: "text/plain" };
    expect(file).toMatchObject({ content: "first\n", sizeBytes: 6, sha256 });
    expect(file).toMatchObject({ path: "notes.txt", ...text });
    const absolute = path.join(root, "notes.txt");
    const direct = await h.api.readFile({ path: absolute });
    expect(direct).toMatchObject({ path: absolute, sha256 });

    const repo = h.initRepo("history", { "src/a.txt": "committed\n" });
    h.write(repo, { "src/a.txt": "working\n" });
    const atHead = { path: "src/a.txt", rootPath: repo, gitRef: "HEAD" };
    const old = await h.api.readFile(atHead);
    expect(old).toMatchObject({ content: "committed\n", sizeBytes: 10 });
    const range = { offset: 3, length: 4, revision: null };
    const chunk = await h.api.readFileChunk({ ...atHead, ...range });
    expect(Buffer.from(chunk.dataBase64, "base64").toString()).toBe("mitt");

    const escapes = [
      h.api.readFile({ path: "../secret.txt", rootPath: root }),
      h.api.readFile({ path: path.join(h.root, "secret.txt"), rootPath: root }),
      h.api.readFile({ path: "link", rootPath: root }),
      h.api.readFile({ path: "notes.txt" }),
      h.api.readFile({ ...atHead, gitRef: "--output=x" }),
      h.api.readFileChunk({ path: "link", rootPath: root, ...range }),
      h.api.writeFile({ path: "../escape.txt", rootPath: root, content: "x" }),
      h.api.writeFile({ path: "dangling", rootPath: root, content: "x" }),
      h.api.mutatePath({ op: "mkdir", path: "../made", rootPath: root }),
      h.api.mutatePath({ op: "remove", path: ".", rootPath: root }),
    ];
    const codes = await Promise.all(escapes.map(failureCode));
    expect(new Set(codes)).toEqual(new Set(["invalid_path"]));
  });

  it("writes with compare-and-set", async () => {
    const target = { path: "state/config.json", rootPath: root };
    const file = path.join(root, target.path);
    const write = (content: string, sha?: string | null, more = {}) =>
      h.api.writeFile({ ...target, content, expectedSha256: sha, ...more });
    expect(await failureCode(write("{}"))).toBe("path_not_found");
    const fresh = { createParents: true, mode: 0o664, expectedSha256: null };
    const created = await write("{}", undefined, fresh);
    const sha256 = sha256Hex("{}");
    expect(created).toEqual({ outcome: "written", sha256, sizeBytes: 2 });
    const conflict = { outcome: "conflict", currentSha256: sha256 };
    expect(await write("x", null)).toEqual(conflict);
    expect(await write("x", sha256Hex("stale"))).toEqual(conflict);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
    expect((await write('{"a":1}', sha256)).outcome).toBe("written");
    expect(fs.readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o664);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]);
    const oversized = write("x".repeat(513 * KIB));
    expect(await failureCode(oversized)).toBe("file_too_large");
  });

  it("transfers large files in chunks and detects a change mid-read", async () => {
    const bytes = Buffer.alloc(700 * KIB, "ab");
    const target = { path: "upload/big.bin", rootPath: root };
    const half = 350 * KIB;
    for (const offset of [0, half]) {
      const part = bytes.subarray(offset, offset + half).toString("base64");
      const sent = { ...target, offset, dataBase64: part, createParents: true };
      expect(await h.api.writeFileChunk(sent)).toEqual({
        sizeBytes: offset + half,
      });
    }
    expect(await failureCode(h.api.readFile(target))).toBe("file_too_large");

    const read = (offset: number, revision: string | null, length = half) =>
      h.api.readFileChunk({ ...target, offset, length, revision });
    const first = await read(0, null);
    expect(first).toMatchObject({ sizeBytes: bytes.length, offset: 0 });
    const rest = await read(half, first.revision);
    const received = [first, rest].map((chunk) =>
      Buffer.from(chunk.dataBase64, "base64"),
    );
    expect(Buffer.concat(received).equals(bytes)).toBe(true);

    fs.appendFileSync(path.join(root, target.path), "changed");
    expect(await failureCode(read(half, first.revision))).toBe("conflict");
    expect((await read(half, null)).sizeBytes).toBe(bytes.length + 7);
    expect(await failureCode(read(0, null, 600 * KIB))).toBe("failed");
  });

  it("lists paths ranked by the query and skips ignored files", async () => {
    const repo = h.initRepo("listing", {
      ".gitignore": "dist/\n*.log\n",
      "src/app.ts": "",
      "src/components/apple-pie.ts": "",
      "docs/guide.md": "",
      ".github/workflow.yml": "",
    });
    const untracked = { "debug.log": "", "src/untracked-app.ts": "" };
    h.write(repo, { "dist/app.js": "", ...untracked });
    fs.rmSync(path.join(repo, "docs/guide.md"));
    const both = { includeFiles: true, includeDirectories: true };
    type Filter = { query?: string; includeHidden?: boolean };
    const list = (rootPath: string, limit: number, filter: Filter = {}) =>
      h.api.listPaths({ rootPath, limit, ...both, ...filter });
    const all = await list(repo, 50);
    expect(all.paths.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "directory:src",
      "file:src/app.ts",
      "directory:src/components",
      "file:src/components/apple-pie.ts",
      "file:src/untracked-app.ts",
    ]);
    const ranked = await list(repo, 2, { query: "app" });
    const best = { kind: "file", path: "src/app.ts", name: "app.ts" };
    expect(ranked.truncated).toBe(true);
    expect(ranked.paths[0]).toMatchObject({ ...best, positions: [4, 5, 6] });
    const dotfiles = { query: "workflow", includeHidden: true };
    const hidden = await list(repo, 5, dotfiles);
    expect(hidden.paths[0]?.path).toBe(".github/workflow.yml");
    const plain = (await list(root, 50)).paths.map((entry) => entry.path);
    expect(plain).toContain("upload/big.bin");
    expect(plain).not.toContain("link");
  });

  it("lists provider commands and skills for the composer", async () => {
    const repo = h.initRepo("commands", {
      ".claude/commands/team/sync.md": "---\ndescription: Sync up\n---\n",
      ".claude/skills/deploy/SKILL.md":
        "---\ndescription: >\n  Ship\n  it\n---",
    });
    const scope = { providerId: "claude-code", cwd: repo } as const;
    const { commands } = await h.api.listCommands(scope);
    const listed = commands
      .filter((entry) => entry.origin !== "user")
      .map((entry) => `${entry.source} ${entry.name}: ${entry.description}`);
    const found = ["skill deploy: Ship it", "command team:sync: Sync up"];
    expect(listed[0]).toMatch(/^command clear: /u);
    expect(listed.slice(2)).toEqual(found);
  });
});
