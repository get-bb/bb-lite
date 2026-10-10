import type { Live, Op, RemoteCallOptions } from "@bb/plugin/app";
import { client } from "../lib/client";

export function callRemoteOp(
  op: Op,
  input: unknown,
  options?: RemoteCallOptions,
): Promise<unknown> {
  return client.call(op, input as never, options);
}

export async function readLive(live: Live): Promise<unknown> {
  const path = `/api/v1/ops/${encodeURIComponent(live.name)}`;
  const response = await client.request(path, { method: "POST", body: "{}" });
  const body = (await response.json()) as { result?: unknown };
  return body.result ?? null;
}
