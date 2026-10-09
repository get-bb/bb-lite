import { describe, expect, it } from "vitest";
import { z } from "zod";
import { contract, createOpClient, op } from "../src/index.js";

const sample = contract("sample", {
  stop: op({
    input: z.object({ id: z.string() }),
    output: z.void(),
    kind: "write",
    doors: { http: { method: "POST", path: "/sample/:id/stop" } },
  }),
  status: op({
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    kind: "read",
    doors: { http: { method: "GET", path: "/sample/:id" } },
  }),
});

function answering(body: unknown) {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  return createOpClient({ baseUrl: "http://bb.test", fetch });
}

describe("op client doors", () => {
  it("reads a door's { ok: true } as no result for an op without output", async () => {
    const client = answering({ ok: true });
    expect(await client.call(sample.stop, { id: "a" })).toBeUndefined();
  });

  it("keeps { ok: true } for an op whose output is that object", async () => {
    const client = answering({ ok: true });
    expect(await client.call(sample.status, { id: "a" })).toEqual({
      ok: true,
    });
  });
});
