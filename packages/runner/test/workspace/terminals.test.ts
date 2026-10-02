import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { until } from "../kit.js";
import { createHarness, failureCode } from "./harness.js";

const decode = (chunks: { dataBase64: string }[]): string =>
  chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")).join("");

describe("terminals and watching", () => {
  const h = createHarness();
  const tailBytes = 1024 * 1024;

  const output = (terminalId: string, fromSeq = 0): string =>
    decode(
      h.events
        .filter((event) => event.kind === "terminal.output")
        .filter((event) => event.terminalId === terminalId)
        .filter((event) => event.seq >= fromSeq),
    );
  const type = (terminalId: string, text: string): Promise<void> => {
    const dataBase64 = Buffer.from(text).toString("base64");
    return h.api.writeTerminal({ terminalId, dataBase64 });
  };
  const open = (terminalId: string, command: string) => {
    const env = { GREETING: "hello" };
    const shape = { cwd: h.root, cols: 80, rows: 24, env };
    const start = { mode: "command", command } as const;
    return h.api.openTerminal({ terminalId, ...shape, start });
  };
  const exitOf = (terminalId: string) =>
    until(
      () =>
        h.events
          .filter((event) => event.kind === "terminal.exited")
          .find((event) => event.terminalId === terminalId),
      `${terminalId} to exit`,
    );

  afterAll(() => h.dispose());

  it("echoes input, resizes, replays from a sequence and reports the exit code", async () => {
    const terminalId = "term_1";
    const opened = await open(terminalId, "exec sh");
    expect(opened).toMatchObject({ title: "exec sh", initialCwd: h.root });
    expect(h.terminalIds()).toEqual([terminalId]);

    const greet = 'echo "$GREETING from $BB_TERMINAL_SESSION_ID"; stty size\n';
    await type(terminalId, greet);
    const greeted = /hello from term_1\r?\n24 80/u;
    await until(() => greeted.test(output(terminalId)), "echoed output");
    const all = { terminalId, sinceSeq: 0, tailBytes };
    const before = await h.api.attachTerminal(all);
    const seqs = before.chunks.map((chunk) => chunk.seq);
    expect(seqs).toEqual(seqs.map((_seq, index) => index));
    expect(before).toMatchObject({ replayStartSeq: 0, nextSeq: seqs.length });

    await h.api.resizeTerminal({ terminalId, cols: 100, rows: 30 });
    await type(terminalId, "stty size\n");
    const sinceSeq = before.nextSeq;
    const resized = (): boolean =>
      output(terminalId, sinceSeq).includes("30 100");
    await until(resized, "resized output");
    const replay = await h.api.attachTerminal({ ...all, sinceSeq });
    expect(replay.replayStartSeq).toBe(sinceSeq);
    expect(decode(replay.chunks)).toContain("30 100");
    expect(decode(replay.chunks)).not.toContain("hello from");

    await type(terminalId, "exit 7\n");
    expect(await exitOf(terminalId)).toMatchObject({ exitCode: 7 });
    expect(h.terminalIds()).toEqual([]);
    const after = await h.api.attachTerminal({ ...all, tailBytes: 16 });
    expect(after.exited).toEqual({ exitCode: 7 });
    expect(after.chunks.map((chunk) => chunk.seq)).toEqual([after.nextSeq - 1]);
    expect(await failureCode(type(terminalId, "x"))).toBe("terminal_not_found");

    await open("term_2", "sleep 60");
    await h.api.closeTerminal({ terminalId: "term_2" });
    expect(await exitOf("term_2")).toMatchObject({ terminalId: "term_2" });
  });

  it("signals working tree, ref and storage directory changes", async () => {
    const repo = h.initRepo("watched", { "a.txt": "a\n" });
    const storage = path.join(h.dataDir, "thread-storage", "thr_1");
    const changes = (target: string): string[] =>
      h.events
        .filter((event) => event.kind === "workspace.changed")
        .filter((event) => event.path === target)
        .map((event) => event.change);
    const none = { workspaces: [], directories: [] };
    const watched = { workspaces: [repo], directories: [storage] };
    await h.api.setWatchedPaths({ generation: 2, ...watched });
    await h.api.setWatchedPaths({ generation: 1, ...none });

    h.write(repo, { "a.txt": "edited\n" });
    await until(() => changes(repo).includes("status"), "status change");
    expect(changes(repo)).not.toContain("refs");
    h.commitAll(repo, "edit");
    await until(() => changes(repo).includes("refs"), "refs change");
    h.write(storage, { "note.md": "saved\n" });
    await until(() => changes(storage).includes("files"), "files change");
  });
});
