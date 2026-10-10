import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as machine from "@bb/runner";
import * as app from "../src/app.js";
import * as server from "../src/index.js";
import { describeTypes } from "../scripts/type-shapes.js";

const { API_VERSION, compareApi, describeApi, satisfies, unpackApi } = server;

it("matches the locked description of every contract", () => {
  const file = new URL("../api.lock.json", import.meta.url);
  const locked = JSON.parse(readFileSync(file, "utf8")) as server.ApiLock;
  const described = describeApi({ ...server, ...app, ...machine });
  const current = server.withTypes(described, describeTypes());
  const changes = compareApi(unpackApi(locked), current);
  const hint = "run `pnpm api:lock` after raising API_VERSION";
  expect({ ...changes, hint }).toEqual({ breaking: [], additive: [], hint });
  expect(current).toEqual(unpackApi(locked));
  expect(locked.version).toBe(API_VERSION);
}, 240_000);

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

it("counts more output, and more for a hook to read, as additions", () => {
  const op = (internal: boolean, input: object, output: object) => ({
    notes: {
      list: {
        type: "op",
        kind: "read",
        hooks: "rewrite",
        allow: "member",
        internal,
        doors: {},
        input,
        output,
      },
    },
  });
  const note = (kinds: string[], extra: object = {}) => ({
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          anyOf: kinds.map((kind) => ({
            type: "object",
            properties: { kind: { const: kind }, ...extra },
          })),
        },
      },
    },
  });
  const wider = compareApi(
    op(false, {}, note(["text"])),
    op(false, {}, note(["text", "image"], { size: {} })),
  );
  expect(wider).toEqual({
    breaking: [],
    additive: ["notes.list: more in the output"],
  });
  const narrower = compareApi(
    op(false, {}, note(["text", "image"])),
    op(false, {}, note(["text"])),
  );
  expect(narrower.breaking).toEqual(["notes.list: the output changed"]);
  const held = { type: "object", properties: { a: {} }, required: ["a"] };
  const told = {
    type: "object",
    properties: { a: {}, b: {} },
    required: ["a", "b"],
  };
  expect(compareApi(op(true, held, {}), op(true, told, {})).breaking).toEqual(
    [],
  );
  expect(compareApi(op(false, held, {}), op(false, told, {})).breaking).toEqual(
    ["notes.list: the input changed"],
  );
});

it("judges a slot entry by who writes each part of it", () => {
  const entry = (properties: object, required: string[]) => ({
    type: "object",
    properties,
    required,
  });
  const view = (props: object) => ({
    component: entry(props, Object.keys(props)),
  });
  const panel = (item: object) => ({
    shell: { panel: { type: "slot", key: "id", pick: "many", item } },
  });
  const id = { type: "string" };
  const base = entry({ id, view: view({ threadId: id }) }, ["id", "view"]);
  const compare = (after: object) =>
    compareApi(panel(base), panel(after)).breaking.length === 0;
  const optional = entry({ id, title: id, view: view({ threadId: id }) }, [
    "id",
    "view",
  ]);
  expect(compare(optional)).toBe(true);
  const demanded = entry({ id, title: id, view: view({ threadId: id }) }, [
    "id",
    "title",
    "view",
  ]);
  expect(compare(demanded)).toBe(false);
  const moreProps = entry({ id, view: view({ threadId: id, projectId: id }) }, [
    "id",
    "view",
  ]);
  expect(compare(moreProps)).toBe(true);
  const fewerProps = entry({ id, view: view({}) }, ["id", "view"]);
  expect(compare(fewerProps)).toBe(false);
  expect(compareApi(panel(base), panel(optional)).additive).toEqual([
    "shell.panel: the entry takes more",
  ]);
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
