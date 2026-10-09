import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ConnectAccount } from "../src/account.js";

const BASE = "https://getbb.test";
const PROFILE = {
  serverId: "srv_1",
  serverLabel: "ada",
  serverUrl: "https://ada.getbb.test/",
};

function account(reply: (path: string, body: unknown) => Response) {
  const calls: { path: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    return reply(path, body);
  };
  const file = join(mkdtempSync(join(tmpdir(), "redeem-")), "connect.json");
  const options = { baseUrl: BASE, clientName: "test", file, fetch };
  const noop = () => undefined;
  return {
    calls,
    file,
    account: new ConnectAccount({ ...options, warn: noop, onChange: noop }),
  };
}

it("redeems a pairing code and stores the link it confirms", async () => {
  const {
    calls,
    file,
    account: connect,
  } = account((path) =>
    path === "/api/connect/redeem"
      ? Response.json({ credential: "cred-9", serverId: "srv_1" })
      : Response.json(PROFILE),
  );
  expect(await connect.redeem("PAIR-1")).toBeNull();
  expect(calls).toEqual([
    { path: "/api/connect/redeem", body: { code: "PAIR-1" } },
    { path: "/api/account/me", body: null },
  ]);
  const stored: unknown = JSON.parse(readFileSync(file, "utf8"));
  expect(stored).toMatchObject({
    credential: "cred-9",
    serverUrl: "https://ada.getbb.test",
    serverLabel: "ada",
    baseUrl: BASE,
  });
});

it("reports a used or expired code without signing in", async () => {
  const used = account(() => Response.json({ error: "used" }, { status: 409 }));
  expect(await used.account.redeem("OLD")).toContain("already used");
  expect(used.account.link).toBeNull();
  const expired = account(() => new Response(null, { status: 410 }));
  expect(await expired.account.redeem("OLD")).toContain("expired");
});
