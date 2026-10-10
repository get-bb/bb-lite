import { randomUUID } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import type { PluginRunnerApi } from "@bb/runner";
import { connect } from "./contract.js";

const CHUNK_BYTES = 1024 * 1024;
const WAIT_MS = 20_000;
const IDLE_MS = 60_000;

type Pending = { response: IncomingMessage; timer: NodeJS.Timeout };

function ask(
  port: number,
  method: string,
  path: string,
  headers: [string, string][],
  body: Buffer | undefined,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const sent = headers.filter(
    ([name]) => !/^(host|content-length)$/iu.test(name),
  );
  sent.push(["host", `127.0.0.1:${port}`]);
  if (body) sent.push(["content-length", String(body.byteLength)]);
  const options = { host: "127.0.0.1", port, method, path };
  return new Promise((resolve, reject) => {
    const stop = () => outgoing.destroy(new Error("the request was cancelled"));
    const outgoing = request({ ...options, headers: sent.flat() }, (got) => {
      signal.removeEventListener("abort", stop);
      resolve(got);
    });
    signal.addEventListener("abort", stop, { once: true });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

async function take(response: IncomingMessage, signal: AbortSignal) {
  const deadline = Date.now() + WAIT_MS;
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    let chunk: Buffer | null = null;
    while (size < CHUNK_BYTES && (chunk = response.read() as Buffer | null)) {
      parts.push(chunk);
      size += chunk.byteLength;
    }
    const done = response.readableEnded;
    if (size > 0 || done || Date.now() >= deadline || signal.aborted) {
      return { data: Buffer.concat(parts).toString("base64"), done };
    }
    if (response.destroyed) {
      throw response.errored ?? new Error("the connection closed early");
    }
    await new Promise<void>((resolve) => {
      const events = ["readable", "end", "close", "error"];
      const timer = setTimeout(wake, deadline - Date.now());
      function wake() {
        clearTimeout(timer);
        for (const name of events) response.off(name, wake);
        signal.removeEventListener("abort", wake);
        resolve();
      }
      for (const name of events) response.once(name, wake);
      signal.addEventListener("abort", wake);
    });
  }
}

export default function connectRunner(bb: PluginRunnerApi): void {
  const pending = new Map<string, Pending>();
  const close = (id: string): void => {
    const held = pending.get(id);
    if (held === undefined) return;
    clearTimeout(held.timer);
    held.response.destroy();
    pending.delete(id);
  };
  const hold = (id: string, response: IncomingMessage): void => {
    clearTimeout(pending.get(id)?.timer);
    const timer = setTimeout(() => close(id), IDLE_MS);
    pending.set(id, { response, timer });
  };
  const next = async (id: string, signal: AbortSignal) => {
    const held = pending.get(id);
    if (held === undefined) throw new Error(`no open share response ${id}`);
    hold(id, held.response);
    try {
      const chunk = await take(held.response, signal);
      if (chunk.done) close(id);
      return { id, ...chunk };
    } catch (error) {
      close(id);
      throw error;
    }
  };

  bb.implement(connect.shareRequest, async (input, { signal }) => {
    const { port, method, path, headers } = input;
    const body =
      input.body === undefined ? undefined : Buffer.from(input.body, "base64");
    const response = await ask(port, method, path, headers, body, signal);
    const id = randomUUID();
    hold(id, response);
    const status = response.statusCode ?? 502;
    const raw = response.rawHeaders;
    const pairs = raw.flatMap((name, index): [string, string][] => {
      const value = raw[index + 1];
      return index % 2 === 0 && value !== undefined ? [[name, value]] : [];
    });
    return { status, headers: pairs, ...(await next(id, signal)) };
  });
  bb.implement(connect.shareChunk, ({ id }, { signal }) => next(id, signal));
  bb.implement(connect.shareClose, ({ id }) => {
    close(id);
    return {};
  });
  bb.onDispose(() => {
    for (const id of [...pending.keys()]) close(id);
  });
}
