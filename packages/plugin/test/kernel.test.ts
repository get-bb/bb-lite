import { expect, it } from "vitest";
import { z } from "zod";
import {
  contract,
  createKernel,
  deny,
  event,
  fail,
  live,
  op,
  service,
  OpError,
  slot,
  type AuditRecord,
  type Caller,
} from "../src/index.js";

const greeting = z.object({ name: z.string(), token: z.string().optional() });
const demo = contract("demo", {
  greet: op({ input: greeting, output: z.string() }),
  rename: op({
    input: greeting,
    output: z.string(),
    kind: "write",
    hooks: "answer",
    secret: ["token"],
  }),
  watch: op({ input: greeting, output: z.string(), hooks: "observe" }),
  reset: op({ input: z.object({}), output: z.void(), allow: "owner" }),
  renamed: event(z.object({ name: z.string() })),
  panel: slot<{ id: string; title: string }>(),
  renderer: slot<{ kind: string; label: string }>({ key: "kind" }),
  sidebar: slot<{ id: string }>({ pick: "one" }),
  clock: service<{ now(): number }>(),
  unread: live(z.number()),
});

function harness(initial: Partial<Caller> = {}, hookBudgetMs = 10_000) {
  const owner = { user: "usr_owner", role: "owner", door: "app" } as const;
  const state = { caller: { ...owner, thread: null, via: [], ...initial } };
  const records: AuditRecord[] = [];
  const warnings: string[] = [];
  const changes: string[] = [];
  const kernel = createKernel({
    currentCaller: () => state.caller,
    enter(caller, work) {
      const previous = state.caller;
      state.caller = caller;
      try {
        return work();
      } finally {
        state.caller = previous;
      }
    },
    record: (entry) => records.push(entry),
    now: () => 5,
    warn: (message) => warnings.push(message),
    changed: (name) => changes.push(name),
    hookBudgetMs,
  });
  const core = kernel.scope("core", "product");
  core.implement(demo.greet, ({ name }) => `hello ${name}`);
  core.implement(demo.rename, ({ name }) => `renamed ${name}`);
  core.implement(demo.watch, ({ name }) => `saw ${name}`);
  core.implement(demo.reset, () => {});
  const trail = () =>
    records.map(({ op: name, outcome, hooks }) => [
      name,
      outcome,
      ...hooks.map(({ plugin, action }) => `${plugin}:${action}`),
    ]);
  return { kernel, core, records, warnings, changes, state, trail };
}

it("runs hooks by tier around the owner and lets them rewrite", async () => {
  const { kernel } = harness();
  const product = kernel.scope("product-plugin", "product");
  const installed = kernel.scope("installed-plugin", "installed");
  const policy = kernel.scope("policy-plugin", "policy");
  const order: string[] = [];
  const tag = (label: string) => async (input: { name: string }, next) => {
    order.push(label);
    return `${await next({ name: `${input.name}+${label}` })}/${label}`;
  };
  product.on(demo.greet, tag("product"));
  installed.on(demo.greet, tag("installed"));
  policy.on(demo.greet, tag("policy"));
  const result = await kernel.call(demo.greet, { name: "bo" });
  expect(order).toEqual(["policy", "installed", "product"]);
  const greeted = "hello bo+policy+installed+product";
  expect(result).toBe(`${greeted}/product/installed/policy`);
});

it("matches hooks on input fields and ignores rewrites of observe-only ops", async () => {
  const { kernel } = harness();
  const plugin = kernel.scope("plugin", "installed");
  plugin.on(demo.greet, { name: "cai" }, async () => "never reached");
  plugin.on(demo.watch, async (_input, next) => {
    await next({ name: "changed" });
    return "replaced";
  });
  expect(await kernel.call(demo.greet, { name: "bo" })).toBe("hello bo");
  expect(await kernel.call(demo.greet, { name: "cai" })).toBe("hello cai");
  expect(await kernel.call(demo.watch, { name: "bo" })).toBe("saw bo");
});

it("lets a hook answer or deny only where the contract allows it", async () => {
  const { kernel, trail } = harness();
  const guard = kernel.scope("guard", "installed");
  guard.on(demo.rename, { name: "root" }, () => deny("root is reserved"));
  guard.on(demo.rename, { name: "cache" }, async () => "served from cache");
  const refused = kernel.call(demo.rename, { name: "root" });
  await expect(refused).rejects.toMatchObject({
    code: "denied",
    plugin: "guard",
    message: "root is reserved",
  });
  const cached = await kernel.call(demo.rename, { name: "cache" });
  expect(cached).toBe("served from cache");
  expect(await kernel.call(demo.rename, { name: "bo" })).toBe("renamed bo");
  expect(trail()).toEqual([
    ["demo.rename", "denied", "guard:denied"],
    ["demo.rename", "ok", "guard:answered"],
    ["demo.rename", "ok"],
  ]);
  expect(() => guard.on(demo.greet, async () => "x").failClosed()).toThrow(
    "cannot be refused",
  );
});

it("skips a failing hook unless it guards", async () => {
  const { kernel, warnings, trail } = harness();
  const flaky = kernel.scope("flaky", "installed");
  const broken = () => {
    throw new Error("boom");
  };
  flaky.on(demo.greet, broken);
  flaky.on(demo.greet, async (input, next) => {
    await next(input);
    throw new Error("late boom");
  });
  expect(await kernel.call(demo.greet, { name: "bo" })).toBe("hello bo");
  expect(warnings).toHaveLength(2);
  flaky.on(demo.rename, { name: "bo" }, broken).failClosed();
  const guarded = kernel.call(demo.rename, { name: "bo" });
  await expect(guarded).rejects.toMatchObject({ code: "denied" });
  expect(trail()).toEqual([["demo.rename", "denied", "flaky:denied"]]);
});

it("passes the owner's own failure through untouched", async () => {
  const { kernel, records } = harness();
  const failure = new Error("disk full");
  const scope = kernel.scope("storage", "product");
  const save = contract("storage", {
    save: op({ input: z.object({}), output: z.void(), kind: "write" }),
  }).save;
  scope.implement(save, () => {
    throw failure;
  });
  scope.on(save, async (input, next) => next(input));
  await expect(kernel.call(save, {})).rejects.toBe(failure);
  expect(records).toMatchObject([{ outcome: "error", detail: "disk full" }]);
});

it("names the plugin and the kind of failure when an owner refuses", async () => {
  const { kernel, trail } = harness();
  const scope = kernel.scope("library", "product");
  const book = z.object({ title: z.string() });
  const library = contract("library", {
    get: op({ input: book, output: z.string() }),
    lend: op({ input: book, output: z.string(), kind: "write" }),
    burn: op({ input: book, output: z.void(), kind: "write" }),
  });
  scope.implement(library.get, ({ title }) =>
    fail("not_found", `No book called ${title}`),
  );
  scope.implement(library.lend, () =>
    fail("conflict", "Already lent", { reason: "book_lent" }),
  );
  scope.implement(library.burn, () => deny("Books are not burned here"));
  const missing = kernel.call(library.get, { title: "Dune" });
  await expect(missing).rejects.toMatchObject({
    code: "not_found",
    plugin: "library",
    message: "No book called Dune",
  });
  const lent = kernel.call(library.lend, { title: "Dune" });
  await expect(lent).rejects.toMatchObject({
    code: "conflict",
    reason: "book_lent",
  });
  const burned = kernel.call(library.burn, { title: "Dune" });
  await expect(burned).rejects.toBeInstanceOf(OpError);
  expect(trail()).toEqual([
    ["library.get", "error"],
    ["library.lend", "error"],
    ["library.burn", "denied"],
  ]);
});

it("learns a whole contract from the plugin that implements part of it", async () => {
  const { kernel } = harness();
  const garden = contract("garden", {
    water: op({ input: z.object({}), output: z.void(), kind: "write" }),
    wilted: event(z.object({ plant: z.string() })),
    bed: slot<{ id: string }>(),
  });
  const scope = kernel.scope("gardener", "product");
  expect(kernel.contracts().map(({ id }) => id)).toEqual(["demo"]);
  scope.implement(garden.water, () => {}, {
    offered: ({ threadId }) => threadId === "thr_1",
  });
  const known = kernel.contracts().find(({ id }) => id === "garden");
  expect(known?.plugin).toBe("gardener");
  expect(Object.keys(known?.members ?? {})).toEqual(["water", "wilted", "bed"]);
  expect(kernel.inspect().contracts).toContainEqual({
    id: "garden",
    plugin: "gardener",
    members: ["water", "wilted", "bed"],
  });
  const { offered } =
    kernel.ops().find(({ op: each }) => each === garden.water) ?? {};
  const context = { projectId: "p", providerId: "echo", hostId: null };
  expect(offered?.({ ...context, threadId: "thr_1" })).toBe(true);
  expect(offered?.({ ...context, threadId: "thr_2" })).toBe(false);
  scope.dispose();
  expect(kernel.contracts().map(({ id }) => id)).toEqual(["demo"]);
});

it("checks who may call and what goes in and out", async () => {
  const { kernel, state } = harness();
  state.caller = { ...state.caller, user: "usr_bo", role: "member" };
  const forbidden = kernel.call(demo.reset, {});
  await expect(forbidden).rejects.toMatchObject({ code: "forbidden" });
  const invalid = kernel.call(demo.greet, { name: 1 } as never);
  await expect(invalid).rejects.toMatchObject({ code: "invalid_input" });
  const orphan = contract("orphan", {
    nobody: op({ input: z.object({}), output: z.string() }),
  });
  const missing = kernel.call(orphan.nobody, {});
  await expect(missing).rejects.toBeInstanceOf(OpError);
  await expect(missing).rejects.toMatchObject({ code: "unimplemented" });
  const liar = kernel.scope("liar", "installed");
  liar.on(demo.greet, async (input, next) => {
    await next(input);
    return 7 as never;
  });
  const wrong = kernel.call(demo.greet, { name: "bo" });
  await expect(wrong).rejects.toMatchObject({ code: "invalid_output" });
});

it("records writes with the caller chain and leaves quiet reads out", async () => {
  const { kernel, records } = harness({ door: "agent", thread: "thr_1" });
  const tasks = kernel.scope("tasks", "product");
  const pool = kernel.scope("pool", "installed");
  pool.on(demo.rename, async (input, next) => next({ ...input, name: "bo2" }));
  await kernel.call(demo.greet, { name: "bo" });
  await tasks.call(demo.rename, { name: "bo", token: "hunter2" });
  expect(records).toEqual([
    {
      at: 5,
      op: "demo.rename",
      kind: "write",
      caller: {
        user: "usr_owner",
        role: "owner",
        door: "agent",
        thread: "thr_1",
        via: ["tasks"],
      },
      hooks: [{ plugin: "pool", action: "rewrote-input" }],
      outcome: "ok",
      detail: null,
      durationMs: 0,
      input: '{"name":"bo","token":"[secret]"}',
    },
  ]);
});

it("delivers events to listeners and survives one that throws", async () => {
  const { kernel, warnings } = harness();
  const heard: string[] = [];
  const first = kernel.scope("first", "product");
  const second = kernel.scope("second", "product");
  first.on(demo.renamed, () => {
    throw new Error("boom");
  });
  second.on(demo.renamed, ({ name }) => heard.push(name));
  kernel.emit(demo.renamed, { name: "bo" });
  kernel.emit(demo.renamed, { name: 3 } as never);
  expect(heard).toEqual(["bo"]);
  expect(warnings).toHaveLength(2);
});

it("collects slot entries, lets a later plugin take a key or a pick-one slot", () => {
  const { kernel } = harness();
  const product = kernel.scope("product-plugin", "product");
  const installed = kernel.scope("installed-plugin", "installed");
  installed.add(demo.renderer, { kind: "work", label: "theirs" });
  product.add(demo.panel, { id: "a", title: "A" });
  product.add(demo.renderer, { kind: "work", label: "ours" });
  product.add(demo.renderer, { kind: "system", label: "ours" });
  product.add(demo.sidebar, { id: "thread-list" });
  installed.add(demo.panel, { id: "b", title: "B" });
  installed.add(demo.sidebar, { id: "compact-nav" });
  expect(kernel.read(demo.panel).map(({ id }) => id)).toEqual(["a", "b"]);
  expect(kernel.find(demo.renderer, "work")?.label).toBe("theirs");
  expect(kernel.find(demo.renderer, "system")?.label).toBe("ours");
  expect(kernel.find(demo.renderer, "none")).toBeNull();
  expect(kernel.read(demo.renderer)).toHaveLength(2);
  expect(kernel.pick(demo.sidebar)).toEqual({ id: "compact-nav" });
  installed.dispose();
  expect(kernel.pick(demo.sidebar)).toEqual({ id: "thread-list" });
  expect(kernel.find(demo.renderer, "work")?.label).toBe("ours");
  expect(kernel.read(demo.panel)).toHaveLength(1);
});

it("undoes everything a plugin registered when it is disposed", async () => {
  const { kernel } = harness();
  const plugin = kernel.scope("plugin", "installed");
  const heard: string[] = [];
  plugin.on(demo.greet, async (input, next) => `${await next(input)}!`);
  plugin.on(demo.renamed, ({ name }) => heard.push(name));
  expect(await kernel.call(demo.greet, { name: "bo" })).toBe("hello bo!");
  const extra = contract("extra", {
    ping: op({ input: z.object({}), output: z.string() }),
  });
  plugin.implement(extra.ping, () => "pong");
  expect(kernel.inspect().ops).toContainEqual({
    name: "extra.ping",
    kind: "read",
    hooks: "rewrite",
    allow: "member",
    owner: "plugin",
    doors: ["app"],
    deprecated: null,
    chain: [],
  });
  plugin.dispose();
  kernel.emit(demo.renamed, { name: "bo" });
  expect(heard).toEqual([]);
  expect(await kernel.call(demo.greet, { name: "bo" })).toBe("hello bo");
  const gone = kernel.call(extra.ping, {});
  await expect(gone).rejects.toMatchObject({ code: "unimplemented" });
  expect(() => plugin.add(demo.panel, { id: "c", title: "C" })).toThrow(
    "was unloaded",
  );
  const successor = kernel.scope("successor", "installed");
  successor.implement(extra.ping, () => "pong again");
  expect(await kernel.call(extra.ping, {})).toBe("pong again");
});

it("lets a plugin wrap another plugin's slot entry and tells watchers", () => {
  const { kernel } = harness();
  const product = kernel.scope("product-plugin", "product");
  const installed = kernel.scope("installed-plugin", "installed");
  let seen = 0;
  const unwatch = kernel.watch(() => (seen += 1));
  product.add(demo.renderer, { kind: "work", label: "row" });
  product.add(demo.renderer, { kind: "system", label: "row" });
  installed.wrap(demo.renderer, { kind: "work" }, (item) => {
    return { ...item, label: `${item.label}+badge` };
  });
  const first = kernel.entries(demo.renderer);
  expect(first).toEqual([
    { plugin: "product-plugin", item: { kind: "work", label: "row+badge" } },
    { plugin: "product-plugin", item: { kind: "system", label: "row" } },
  ]);
  expect(kernel.entries(demo.renderer)).toBe(first);
  expect([seen, kernel.version()]).toEqual([3, 3]);
  installed.dispose();
  expect(kernel.find(demo.renderer, "work")?.label).toBe("row");
  unwatch();
  product.add(demo.panel, { id: "a", title: "A" });
  expect(seen).toBe(4);
});

it("provides services and live values, and announces changes", () => {
  const { kernel, changes } = harness();
  const plugin = kernel.scope("plugin", "product");
  expect(() => kernel.use(demo.clock)).toThrow("Nothing provides demo.clock");
  plugin.add(demo.clock, { now: () => 42 });
  expect(kernel.use(demo.clock).now()).toBe(42);
  expect(kernel.value(demo.unread)).toBeUndefined();
  const unread = plugin.provide(demo.unread, 1);
  unread.update((count) => count + 2);
  expect([unread.get(), kernel.value(demo.unread)]).toEqual([3, 3]);
  expect(() => unread.set("many" as never)).toThrow();
  plugin.changed(demo.greet);
  expect(changes).toEqual(["demo.unread", "demo.greet"]);
  expect(kernel.live("demo.unread")).toBe(demo.unread);
  plugin.dispose();
  expect(kernel.value(demo.unread)).toBeUndefined();
});

it("skips a hook that runs past its budget but not one waiting on next", async () => {
  const { kernel, warnings } = harness({}, 30);
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const slow = kernel.scope("slow", "installed");
  const patient = kernel.scope("patient", "policy");
  slow.on(demo.greet, async (input, next) => {
    await pause(80);
    return `${await next(input)} eventually`;
  });
  patient.on(demo.greet, async (input, next) => `${await next(input)}!`);
  expect(await kernel.call(demo.greet, { name: "bo" })).toBe("hello bo!");
  expect(warnings).toEqual(["A plugin hook failed"]);
});

it("hands the implementation a signal and the caller", async () => {
  const { kernel } = harness();
  const abort = new AbortController();
  const probe = contract("probe", {
    look: op({ input: z.object({}), output: z.string() }),
  });
  kernel.scope("probe", "product").implement(probe.look, (_input, context) => {
    return `${context.caller.door}:${context.signal === abort.signal}`;
  });
  const options = { signal: abort.signal };
  expect(await kernel.call(probe.look, {}, options)).toBe("app:true");
});

it("warns once per plugin when a deprecated operation is used", async () => {
  const { kernel, warnings } = harness();
  const old = contract("old", {
    hello: op({
      input: z.object({}),
      output: z.string(),
      deprecated: "demo.greet",
    }),
  });
  kernel.scope("owner", "product").implement(old.hello, () => "hi");
  const caller = kernel.scope("caller", "installed");
  expect(await caller.call(old.hello, {})).toBe("hi");
  await caller.call(old.hello, {});
  caller.on(old.hello, (_input, next) => next());
  expect(warnings).toEqual(["A deprecated operation was used"]);
  await kernel.call(old.hello, {});
  expect(warnings).toHaveLength(2);
  expect(kernel.inspect()).toMatchObject({ api: expect.any(String) });
});
