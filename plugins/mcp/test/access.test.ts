import { describe, expect, it } from "vitest";
import { mcpAccessProblem } from "../src/access.js";

const TOKEN = "tunnel-secret";
const VIA = { "x-bb-via-tunnel": TOKEN };
const OAUTH = { "x-bb-gate-auth": "oauth", "x-bb-gate-oauth-scope": "bb" };

function problem(headers: Record<string, string>, ownMachine = false) {
  const trust = { ownMachine, tunnelToken: TOKEN };
  return mcpAccessProblem(new Headers(headers), trust);
}

describe("a request that did not come through the tunnel", () => {
  it("is accepted from the server's own machine", () => {
    expect(problem({}, true)).toBeNull();
  });

  it("is refused from anywhere else, signed in or not", () => {
    expect(problem({})).toMatchObject({ status: 403 });
    expect(problem({ cookie: "bb_session_1=abc" })).toMatchObject({
      status: 403,
    });
  });

  it("is refused when it comes from a web page", () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1:38886"]) {
      expect(problem({ origin }, true)).toMatchObject({ status: 403 });
    }
  });

  it("is refused when it carries gate headers nobody verified", () => {
    expect(problem(OAUTH)).toMatchObject({ status: 403 });
    expect(problem(OAUTH, true)).toMatchObject({ status: 403 });
  });
});

describe("a request that came through the tunnel", () => {
  it("is accepted with an OAuth token for bb", () => {
    expect(problem({ ...VIA, ...OAUTH })).toBeNull();
    const scoped = { ...OAUTH, "x-bb-gate-oauth-scope": "openid bb" };
    expect(problem({ ...VIA, ...scoped })).toBeNull();
  });

  it("is refused when the tunnel marker is not this server's", () => {
    const forged = { ...OAUTH, "x-bb-via-tunnel": "guess" };
    expect(problem(forged)).toMatchObject({ status: 403 });
    expect(problem(forged, true)).toMatchObject({ status: 403 });
  });

  it.each(["session", "machine", "", "OAuth"])(
    "is refused when the gate authenticated it as %j",
    (kind) => {
      const headers = { ...VIA, ...OAUTH, "x-bb-gate-auth": kind };
      expect(problem(headers)).toMatchObject({ status: 403 });
      expect(problem(headers, true)).toMatchObject({ status: 403 });
    },
  );

  it("is refused with no gate stamp, even for the owner's session", () => {
    expect(problem(VIA, true)).toMatchObject({ status: 403 });
  });

  it("is refused without the bb scope", () => {
    for (const scope of ["", "openid", "bbx", "bb:all"]) {
      const headers = { ...VIA, ...OAUTH, "x-bb-gate-oauth-scope": scope };
      expect(problem(headers)).toMatchObject({ status: 403 });
    }
  });
});
