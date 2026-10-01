import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, failureCode, type Harness } from "./harness.js";

describe("terminals and watching", () => {
  let h: Harness;

  const output = (terminalId: string, fromSeq = 0): string =>
    h.events
      .filter((event) => event.kind === "terminal.output")
      .filter((event) => event.terminalId === terminalId)
      .filter((event) => event.seq >= fromSeq)
      .map((event) => Buffer.from(event.dataBase64, "base64").toString())
      .join("");
  const type = (terminalId: string, text: string): Promise<void> =>
    h.api.writeTerminal({
      terminalId,
      dataBase64: Buffer.from(text).toString("base64"),
    });

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(() => h.dispose());

  it("echoes input, resizes, replays from a sequence and reports the exit code", async () => {
    const terminalId = "term_1";
    const opened = await h.api.openTerminal({
      terminalId,
      cwd: h.root,
      cols: 80,
      rows: 24,
      start: { mode: "command", command: "exec sh" },
      env: { PS1: "ready> ", GREETING: "hello" },
    });
    expect(opened).toMatchObject({
      title: "exec sh",
      initialCwd: h.root,
      cols: 80,
      rows: 24,
    });
    expect(h.handle.terminalIds()).toEqual([terminalId]);
    const duplicate = h.api.openTerminal({
      terminalId,
      cwd: null,
      cols: 80,
      rows: 24,
      start: { mode: "shell" },
      env: {},
    });
    expect(await failureCode(duplicate)).toBe("conflict");

    await type(
      terminalId,
      'echo "$GREETING from $BB_TERMINAL_SESSION_ID"; stty size\n',
    );
    await h.waitFor(
      () => /hello from term_1\r?\n24 80/u.test(output(terminalId)),
      "echoed output",
    );
    const before = await h.api.attachTerminal({
      terminalId,
      sinceSeq: 0,
      tailBytes: 1024 * 1024,
    });
    expect(before.replayStartSeq).toBe(0);
    expect(before.exited).toBeNull();
    expect(before.chunks.map((chunk) => chunk.seq)).toEqual(
      before.chunks.map((_chunk, index) => index),
    );
    expect(before.nextSeq).toBe(before.chunks.length);

    await h.api.resizeTerminal({ terminalId, cols: 100, rows: 30 });
    await type(terminalId, "stty size\n");
    await h.waitFor(
      () => output(terminalId, before.nextSeq).includes("30 100"),
      "resized output",
    );
    const replay = await h.api.attachTerminal({
      terminalId,
      sinceSeq: before.nextSeq,
      tailBytes: 1024 * 1024,
    });
    const replayed = replay.chunks
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString())
      .join("");
    expect(replay.replayStartSeq).toBe(before.nextSeq);
    expect(replayed).toContain("30 100");
    expect(replayed).not.toContain("hello from");

    await type(terminalId, "exit 7\n");
    const exited = await h.waitFor(
      () => h.events.find((event) => event.kind === "terminal.exited"),
      "exit event",
    );
    expect(exited).toMatchObject({ terminalId, exitCode: 7 });
    expect(h.handle.terminalIds()).toEqual([]);
    const after = await h.api.attachTerminal({
      terminalId,
      sinceSeq: 0,
      tailBytes: 16,
    });
    expect(after.exited).toEqual({ exitCode: 7 });
    expect(after.chunks).toHaveLength(1);
    expect(after.chunks[0]?.seq).toBe(after.nextSeq - 1);
    expect(await failureCode(type(terminalId, "x"))).toBe("terminal_not_found");
  });

  it("closes a running terminal", async () => {
    const terminalId = "term_2";
    await h.api.openTerminal({
      terminalId,
      cwd: h.root,
      cols: 80,
      rows: 24,
      start: { mode: "command", command: "sleep 60" },
      env: {},
    });
    await h.api.closeTerminal({ terminalId });
    const exited = await h.waitFor(
      () =>
        h.events.find(
          (event) =>
            event.kind === "terminal.exited" && event.terminalId === terminalId,
        ),
      "close event",
    );
    expect(exited).toMatchObject({ kind: "terminal.exited" });
    await h.api.closeTerminal({ terminalId: "term_unknown" });
  });

  it("signals working tree, ref and storage directory changes", async () => {
    const repo = h.initRepo("watched", {
      "a.txt": "a\n",
      ".gitignore": "out/\n",
    });
    const storage = path.join(h.dataDir, "thread-storage", "thr_1");
    const changes = (target: string): string[] =>
      h.events
        .filter((event) => event.kind === "workspace.changed")
        .filter((event) => event.path === target)
        .map((event) => event.change);
    const watched = { workspaces: [repo], directories: [storage] };
    await h.api.setWatchedPaths({ generation: 2, ...watched });
    await h.api.setWatchedPaths({
      generation: 1,
      workspaces: [],
      directories: [],
    });

    h.write(path.join(repo, "a.txt"), "edited\n");
    await h.waitFor(() => changes(repo).includes("status"), "status change");
    expect(changes(repo)).not.toContain("refs");

    h.git(repo, "commit", "--quiet", "-am", "edit");
    await h.waitFor(() => changes(repo).includes("refs"), "refs change");

    expect(fs.statSync(storage).isDirectory()).toBe(true);
    h.write(path.join(storage, "note.md"), "saved\n");
    await h.waitFor(() => changes(storage).includes("files"), "files change");

    await h.api.setWatchedPaths({
      generation: 3,
      workspaces: [],
      directories: [],
    });
    const settled = h.events.length;
    h.write(path.join(repo, "a.txt"), "after unwatch\n");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(h.events.length).toBe(settled);
  });
});
