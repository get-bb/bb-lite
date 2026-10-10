import { createRunnerPlugins } from "@bb/runner";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, onTestFinished } from "vitest";
import { scratch } from "../../../apps/server/test/helpers.js";
import connectRunner from "../src/runner.js";

type Chunk = { id: string; data: string; done: boolean };

it("streams a response in chunks as the origin writes them", async () => {
  const open = new Set<ServerResponse>();
  const origin = createServer((_request, response) => {
    open.add(response);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: one\n\n");
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  onTestFinished(() => void origin.close());
  const { port } = origin.address() as AddressInfo;
  const machine = createRunnerPlugins({ dataDir: scratch(), sink: () => {} });
  onTestFinished(() => machine.dispose());
  machine.load({ id: "connect", entry: connectRunner });
  const text = (chunk: Chunk) => Buffer.from(chunk.data, "base64").toString();

  const input = { port, method: "GET", path: "/events", headers: [] };
  const head = (await machine.callOp("connect.shareRequest", input)) as Chunk;
  expect([text(head), head.done]).toEqual(["data: one\n\n", false]);
  const next = machine.callOp("connect.shareChunk", { id: head.id });
  for (const response of open) response.end("data: two\n\n");
  const tail = (await next) as Chunk;
  expect(text(tail)).toBe("data: two\n\n");
  const rest = tail.done
    ? tail
    : ((await machine.callOp("connect.shareChunk", { id: head.id })) as Chunk);
  expect(rest.done).toBe(true);
  const second = (await machine.callOp("connect.shareRequest", input)) as Chunk;
  await machine.callOp("connect.shareClose", { id: second.id });
  await expect(
    machine.callOp("connect.shareChunk", { id: second.id }),
  ).rejects.toThrow(/no open share response/u);
});
