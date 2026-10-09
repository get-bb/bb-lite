import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { PreviewFrame } from "../contract.js";
import type { PreviewSocket } from "../preview.js";
import { createPreview } from "../preview.js";
import { decodeOutput, launchSession, type RuntimeIo } from "../runtime.js";

const URL_ = "ws://127.0.0.1:9333/devtools/browser/secret-token";
const frames = (...lines: object[]) =>
  lines.map((line) => JSON.stringify(line)).join("\n");

class FakeSocket implements PreviewSocket {
  readyState = 0;
  sent: { id: number; method: string; sessionId?: string }[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  fire(type: string, data?: object) {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? [])
      listener({ data: JSON.stringify(data) });
  }
  reply(method: string, result: object) {
    const call = [...this.sent].reverse().find((m) => m.method === method);
    this.fire("message", { id: call?.id, result });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

it("launches Chrome and the daemon supervised, runs scripts and cleans up", async () => {
  const temp = await mkdtemp(join(tmpdir(), "bb-browser-test-"));
  const started: string[][] = [];
  const executed: string[][] = [];
  let closed = 0;
  const io: RuntimeIo = {
    findChrome: async () => "/fake/chrome",
    supervise: (command, args, env) => {
      started.push([command, ...args]);
      const profile = args
        .find((a) => a.startsWith("--user-data-dir="))
        ?.slice("--user-data-dir=".length);
      void (async () => {
        if (profile !== undefined) {
          await mkdir(profile, { recursive: true });
          await writeFile(
            join(profile, "DevToolsActivePort"),
            "9333\n/devtools/browser/secret-token\n",
          );
        } else
          await writeFile(
            join(String(env.DEV_BROWSER_HOME), "daemon.pid"),
            "1",
          );
      })();
      return { alive: () => true, close: async () => void (closed += 1) };
    },
    execute: async (command, args, env) => {
      executed.push([command, ...args]);
      const home = String(env.DEV_BROWSER_HOME);
      const shot = join(home, "tmp", "shot.jpg");
      await writeFile(shot, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
      return frames(
        { type: "hello", protocol: 1, version: "1.0.0", pid: 7 },
        { type: "stdout", data: `connected to ${URL_} in ${home}` },
        { type: "image", path: shot, width: 10, height: 20 },
        { type: "done", exitCode: 0, durationMs: 3 },
      );
    },
    openSocket: () => new FakeSocket(),
  };
  const session = await launchSession({
    binary: "/fake/dev-browser",
    version: "1.0.0",
    dataDir: temp,
    tempDir: temp,
    signal: new AbortController().signal,
    io,
  });
  expect(started[0]).toContain("--headless=new");
  expect(started[0]).toContain("--remote-debugging-port=0");
  expect(started[1]).toEqual(["/fake/dev-browser", "daemon"]);
  expect(executed[0]?.slice(0, 4)).toEqual([
    "/fake/dev-browser",
    "--json",
    "--connect",
    "ws://127.0.0.1:9333/devtools/browser/secret-token",
  ]);
  const output = await session.run(
    "await page.goto('x')",
    5_000,
    new AbortController().signal,
  );
  expect(output.text).toBe(
    "connected to [browser connection] in [session storage]",
  );
  expect(output.images).toHaveLength(1);
  expect(executed[1]?.at(-1)).toBe("await page.goto('x')");
  await session.close();
  expect(closed).toBe(2);
  expect(await readdir(temp)).toEqual([]);
});

it("rejects bad frames: version mismatch, missing done, oversized and stray images", async () => {
  const home = await mkdtemp(join(tmpdir(), "bb-browser-home-"));
  await mkdir(join(home, "tmp"));
  const done = { type: "done", exitCode: 0, durationMs: 1 };
  await expect(
    decodeOutput(
      frames({ type: "hello", protocol: 1, version: "9", pid: 1 }, done),
      home,
      URL_,
      "1",
    ),
  ).rejects.toThrow("expected 1");
  await expect(
    decodeOutput(frames({ type: "result", value: "x" }), home, URL_, "1"),
  ).rejects.toThrow("completion frame");
  await expect(
    decodeOutput(frames(done, done), home, URL_, "1"),
  ).rejects.toThrow("after completion");
  const big = join(home, "tmp", "big.jpg");
  await writeFile(big, Buffer.alloc(600_000, 0xff));
  await expect(
    decodeOutput(
      frames({ type: "image", path: big, width: 1, height: 1 }, done),
      home,
      URL_,
      "1",
    ),
  ).rejects.toThrow("500 KB");
  const outside = join(home, "outside.jpg");
  await writeFile(outside, Buffer.from([0xff, 0xd8, 0xff]));
  await expect(
    decodeOutput(
      frames({ type: "image", path: outside, width: 1, height: 1 }, done),
      home,
      URL_,
      "1",
    ),
  ).rejects.toThrow("escaped");
  const output = await decodeOutput(
    frames(
      { type: "error", kind: "x", name: "E", message: "secret-token" },
      {
        ...done,
        exitCode: 1,
      },
    ),
    home,
    URL_,
    "1",
  );
  expect(output).toEqual({ text: "E: [credential]", images: [], exitCode: 1 });
});

it("screencasts the most recent non-blank page and acknowledges frames", async () => {
  const socket = new FakeSocket();
  const received: PreviewFrame[] = [];
  const preview = createPreview(URL_, () => socket, {
    ackMs: 0,
    idleMs: 60_000,
    fullHoldMs: 10_000,
  });
  preview.request("thumbnail", (frame) => received.push(frame));
  socket.fire("open");
  expect(socket.sent[0]?.method).toBe("Target.setDiscoverTargets");
  socket.fire("message", {
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        targetId: "t1",
        type: "page",
        url: "https://a",
        title: "A",
      },
    },
  });
  await settle();
  socket.reply("Target.attachToTarget", { sessionId: "s1" });
  await settle();
  const start = socket.sent.at(-1);
  expect(start).toMatchObject({
    method: "Page.startScreencast",
    sessionId: "s1",
  });
  socket.reply("Page.startScreencast", {});
  socket.fire("message", {
    method: "Page.screencastFrame",
    sessionId: "s1",
    params: {
      data: "AAAA",
      sessionId: 4,
      metadata: { deviceWidth: 800, deviceHeight: 450 },
    },
  });
  await settle();
  expect(received).toEqual([
    {
      sequence: 1,
      mimeType: "image/jpeg",
      data: "AAAA",
      width: 800,
      height: 450,
      url: "https://a",
      title: "A",
    },
  ]);
  expect(socket.sent.at(-1)?.method).toBe("Page.screencastFrameAck");
  preview.request("full", (frame) => received.push(frame));
  expect(received).toHaveLength(2);
  await settle();
  expect(socket.sent.at(-1)?.method).toBe("Page.stopScreencast");
  preview.close();
  expect(socket.readyState).toBe(3);
});
