import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as machine from "@bb/runner";
import * as app from "../src/app.js";
import * as server from "../src/index.js";

const { API_VERSION, compareApi, describeApi, satisfies, unpackApi } = server;

it("matches the locked description of every contract", () => {
  const file = new URL("../api.lock.json", import.meta.url);
  const locked = JSON.parse(readFileSync(file, "utf8")) as server.ApiLock;
  const current = describeApi({ ...server, ...app, ...machine });
  const changes = compareApi(unpackApi(locked), current);
  const hint = "run `pnpm api:lock` after raising API_VERSION";
  expect({ ...changes, hint }).toEqual({ breaking: [], additive: [], hint });
  expect(current).toEqual(unpackApi(locked));
  expect(locked.version).toBe(API_VERSION);
});

it("tells an added field from a removed one and a moved door", () => {
  const op = (extra: object) => ({
    type: "op",
    kind: "read",
    hooks: "rewrite",
    allow: "member",
    internal: false,
    doors: { http: "GET /notes" },
    input: { type: "object", properties: { a: {} }, required: ["a"] },
    output: {},
    ...extra,
  });
  const input = (properties: object, required: string[]) => ({
    input: { type: "object", properties, required },
  });
  const before = { notes: { list: op({}), old: op({}) } };
  const after = {
    notes: {
      list: op(input({ a: {}, b: {} }, ["a"])),
      fresh: op({}),
    },
  };
  expect(compareApi(before, after)).toEqual({
    breaking: ["notes.old: removed"],
    additive: ["notes.list: new optional input", "notes.fresh: new"],
  });
  const required = { notes: { list: op(input({ a: {}, b: {} }, ["a", "b"])) } };
  const narrowed = compareApi({ notes: { list: op({}) } }, required);
  expect(narrowed.breaking).toEqual(["notes.list: the input changed"]);
  const moved = { doors: { http: "GET /memos", also: ["/notes"] } };
  const kept = compareApi(
    { notes: { list: op({}) } },
    { notes: { list: op(moved) } },
  );
  expect(kept).toEqual({
    breaking: [],
    additive: [
      "notes.list: served at a new path too",
      "notes.list: new also door",
    ],
  });
  const dropped = { doors: { http: "GET /memos" } };
  const lost = compareApi(
    { notes: { list: op({}) } },
    { notes: { list: op(dropped) } },
  );
  expect(lost.breaking).toEqual(["notes.list: the http door changed"]);
});

it("reads version ranges the way package managers do", () => {
  const cases: [string, string, boolean][] = [
    ["1.4.2", "^1.2", true],
    ["2.0.0", "^1.2", false],
    ["1.1.9", "^1.2", false],
    ["0.3.1", "^0.3.0", true],
    ["0.4.0", "^0.3.0", false],
    ["1.4.2", "~1.4", true],
    ["1.5.0", "~1.4", false],
    ["1.0.0", ">=0.0", true],
    ["1.0.0", ">=1.1 <2", false],
    ["1.6.0", ">= 1.1 <2", true],
    ["3.0.0", "1 || 3", true],
    ["2.0.0", "1 || 3", false],
    ["1.0.0", "*", true],
    ["1.0.0", "next week", false],
  ];
  for (const [version, range, expected] of cases) {
    expect([version, range, satisfies(version, range)]).toEqual([
      version,
      range,
      expected,
    ]);
  }
});

it("speaks the same API version from the native CLI", () => {
  const file = new URL("../../../crates/bb-cli/src/http.rs", import.meta.url);
  const declared = /API_VERSION: &str = "([^"]+)"/u.exec(
    readFileSync(file, "utf8"),
  );
  expect(declared?.[1]).toBe(API_VERSION);
});
