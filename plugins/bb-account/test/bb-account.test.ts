import { createPluginHarness } from "@bb/plugin/testing";
import { expect, it } from "vitest";
import { connect, type ConnectStatus } from "../../connect/src/contract.js";
import { bbAccount, describeAccount } from "../contract.js";
import { createBbAccount } from "../server.js";

const LINK = {
  baseUrl: "https://getbb.test",
  serverUrl: "https://ada.getbb.test",
  credential: "cred-1",
};

function connectStatus(paired: boolean): ConnectStatus {
  return {
    state: paired ? "connected" : "disconnected",
    paired,
    enabled: true,
    handle: paired ? "ada" : null,
    url: paired ? LINK.serverUrl : null,
    lastError: null,
    nextRetryAt: null,
    login: null,
    shares: [],
  };
}

async function setup(withCredential = true) {
  const harness = createPluginHarness();
  let paired = false;
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  harness.stub(connect.status, () => connectStatus(paired));
  harness.stub(connect.login, () => {
    paired = true;
    return connectStatus(paired);
  });
  harness.stub(connect.logout, () => {
    paired = false;
    return connectStatus(paired);
  });
  if (withCredential) {
    await harness.load("connect", (bb) => {
      bb.add(bbAccount.credential, () => (paired ? LINK : null));
    });
  }
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ text: "ok" });
  };
  const plugin = createBbAccount({ fetch, refreshMs: 60_000, waitMs: 1 });
  const { api } = await harness.load("bb-account", plugin);
  return { api, requests, harness };
}

it("reports the account bb connect signed in to and signs in and out", async () => {
  const { api } = await setup();
  const before = await api.call(bbAccount.status, {});
  expect(before).toMatchObject({ signedIn: false, hosted: false });
  expect(describeAccount(before)).toContain("Not signed in");
  const after = await api.call(bbAccount.login, { wait: true });
  expect(after).toMatchObject({ signedIn: true, handle: "ada", hosted: true });
  expect(describeAccount(after)).toContain("Signed in as ada");
  const out = await api.call(bbAccount.logout, {});
  expect(out.signedIn).toBe(false);
});

it("tells other plugins when the account changes", async () => {
  const { api } = await setup();
  const seen: boolean[] = [];
  api.on(bbAccount.changed, (status) => void seen.push(status.signedIn));
  await api.call(bbAccount.status, {});
  await api.call(bbAccount.login, {});
  await api.call(bbAccount.status, {});
  expect(seen).toEqual([false, true]);
});

it("signs requests to hosted services without handing out the credential", async () => {
  const { api, requests } = await setup();
  const ask = {
    method: "POST",
    path: "/api/ai/v1/complete",
    body: {},
  } as const;
  expect((await api.call(bbAccount.fetch, ask)).status).toBe(401);
  expect(requests).toHaveLength(0);
  await api.call(bbAccount.login, {});
  const reply = await api.call(bbAccount.fetch, ask);
  expect(reply).toEqual({ status: 200, body: { text: "ok" } });
  expect(requests[0]?.url).toBe("https://getbb.test/api/ai/v1/complete");
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
    "Bearer cred-1",
  );
  const escape = { method: "GET", path: "/api/connect/x" } as const;
  await expect(api.call(bbAccount.fetch, escape)).rejects.toThrow();
});

it("is signed in but not hosted while no plugin shares the credential", async () => {
  const { api } = await setup(false);
  const status = await api.call(bbAccount.login, {});
  expect(status).toMatchObject({ signedIn: true, hosted: false });
});
