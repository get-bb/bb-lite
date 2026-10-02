import { expect, it } from "vitest";
import { closeTerminalsFor } from "../src/terminals/sessions.js";
import {
  createDemo,
  git,
  insertThread,
  watchChanges,
  write,
  type SocketMessage,
  type TestSocket,
} from "./helpers.js";

type Chunk = { seq: number; dataBase64: string };
const base64 = (text: string): string => Buffer.from(text).toString("base64");
const decode = (chunk?: Chunk): string =>
  Buffer.from(chunk?.dataBase64 ?? "", "base64").toString();
const typing = (text: string) => ({ type: "input", dataBase64: base64(text) });
const isType = (wanted: string) => (message: SocketMessage) =>
  message.type === wanted;
const shell = { cols: 80, rows: 24 };

async function outputUntil(socket: TestSocket, marker: string) {
  let text = "";
  let lastSeq = -1;
  while (!text.includes(marker)) {
    const { chunk } = await socket.next(isType("output"));
    text += decode(chunk as Chunk);
    lastSeq = (chunk as Chunk).seq;
  }
  return { text, lastSeq };
}

it("runs terminals through attach, replay, exit and a lost machine", async () => {
  const demo = await createDemo();
  const { server, projectId, hostId, matches, read, request, send } = demo;
  const { runner, ctx } = server;
  const changed = await watchChanges(server);
  insertThread(server, "thr_demo", projectId);
  ctx.db.run("UPDATE threads SET environment_id = 'env_demo'");
  const target = { kind: "thread", threadId: "thr_demo" };
  const open = async () => {
    const created = await send("/terminals", { ...shell, target });
    return (await created.json()) as { id: string };
  };
  const terminal = await open();
  const route = `/terminals/${terminal.id}`;
  const attachAt = (sinceSeq: number | string) =>
    server.socket(`/ws${route}?sinceSeq=${sinceSeq}`);
  await changed("thread", "terminals-changed");
  const sessions = [{ id: terminal.id, environmentId: "env_demo" }];
  await matches("/terminals?threadId=thr_demo", { sessions });
  expect((await request("/terminals")).status).toBe(400);

  const first = await attachAt(0);
  const session = { id: terminal.id, status: "running" };
  expect(await first.next()).toMatchObject({ type: "attached", session });
  first.send(typing("echo marker-$((40+2))\n"));
  const echoed = await outputUntil(first, "marker-42");
  first.send({ type: "resize", cols: 100, rows: 30 });
  await first.next(isType("session-updated"));
  const second = await attachAt(0);
  expect(await second.next()).toMatchObject({ type: "attached" });
  expect((await outputUntil(second, "marker-42")).lastSeq).toBe(echoed.lastSeq);
  first.send({ type: "resize", cols: 90, rows: 30 });
  first.send({ type: "ping" });
  await first.next(isType("pong"));
  await matches(route, { cols: 100, rows: 30 });
  first.socket.close();
  second.socket.close();

  const resumeAt = echoed.lastSeq + 1;
  const resumed = await attachAt(resumeAt);
  const replay = { type: "attached", replayStartSeq: resumeAt };
  expect(await resumed.next()).toMatchObject(replay);
  const typed = { dataBase64: base64("echo again-$((1+1))\n") };
  expect((await send(`${route}/input`, typed)).status).toBe(200);
  const later = await outputUntil(resumed, "again-2");
  expect(later.text).not.toContain("marker-42");
  const output = (await read(`${route}/output`)) as { chunks: Chunk[] };
  expect(output).toMatchObject({ truncated: false, status: "running" });
  expect(output.chunks.map(decode).join("")).toMatch(/marker-42[^]*again-2/u);

  await expect(attachAt("x")).rejects.toThrow(
    "Unexpected server response: 400",
  );
  const unknown = await server.socket("/ws/terminals/term_none");
  expect(await unknown.next()).toMatchObject({ code: "terminal_not_found" });

  resumed.send(typing("exit\n"));
  const exited = { status: "exited", exitCode: 0, closeReason: "process-exit" };
  const farewell = await resumed.next(isType("exited"));
  expect(farewell).toMatchObject({ session: exited });
  await changed("thread", "terminals-changed");
  await matches("/terminals?threadId=thr_demo", { sessions: [] });
  expect((await send(`${route}/input`, typed)).status).toBe(409);

  const { id } = await open();
  const held = await server.socket(`/ws/terminals/${id}?sinceSeq=0`);
  await held.next(isType("attached"));
  const live = { sessions: [], pendingRequestIds: [], lastEventSeq: 0 };
  runner.script.snapshot = async () => ({ ...live, terminalIds: [id] });
  const updated = async (status: string) => {
    const frame = await held.next(isType("session-updated"));
    expect(frame).toMatchObject({ session: { id, status } });
  };
  ctx.runners.disconnect(hostId);
  await updated("disconnected");
  ctx.runners.connect(hostId, (sink) => {
    runner.emit = sink;
    return runner.api;
  });
  await updated("running");
  held.send(typing("echo back-$((2+3))\n"));
  await outputUntil(held, "back-5");
  const force = { mode: "force", reason: "user" };
  const closed = await send(`/terminals/${id}/close`, force);
  expect(await closed.json()).toMatchObject({ closeReason: "user" });

  const doomed = await open();
  closeTerminalsFor(ctx, "thread_id", "thr_demo", "thread-archived");
  const archived = { status: "exited", closeReason: "thread-archived" };
  await matches(`/terminals/${doomed.id}`, archived);
});

it("watches a subscribed environment and reports edits and branches", async () => {
  const { server, repo, matches } = await createDemo();
  const { setWatchedPaths } = server.runner.script;
  const watching = new Promise<void>((resolve) => {
    server.runner.script.setWatchedPaths = async (args) => {
      await setWatchedPaths?.(args);
      if (args.workspaces.includes(repo)) resolve();
    };
  });
  const client = await server.socket();
  const environmentId = "env_demo";
  await client.subscribe({ kind: "environment-detail", environmentId });
  await watching;
  const changedTo = (kind: string) =>
    client.next(({ changes }) => (changes as string[]).includes(kind));
  write(repo, { "src/a.ts": "export const a = 3;\n" });
  await changedTo("work-status-changed");
  git(repo, "switch", "--quiet", "-c", "topic");
  await changedTo("git-refs-changed");
  await changedTo("metadata-changed");
  await matches("/environments/env_demo", { branchName: "topic" });
});
