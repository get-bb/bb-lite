import type { z } from "zod";
import type {
  Allow,
  EventDef,
  HookPower,
  Live,
  Op,
  OpKind,
  Slot,
} from "./contract.js";

export type Door = "app" | "cli" | "agent" | "http" | "system";
export const DOOR_HEADER = "x-bb-door";
export type CallerRole = "owner" | "member" | "system";
export type Tier = "policy" | "installed" | "product";
export type HookAction =
  | "rewrote-input"
  | "rewrote-output"
  | "answered"
  | "denied"
  | "failed";
export type OpOutcome = "ok" | "denied" | "error";
export type OpErrorCode =
  | "denied"
  | "forbidden"
  | "unimplemented"
  | "invalid_input"
  | "invalid_output";

export interface Caller {
  user: string | null;
  role: CallerRole;
  door: Door;
  thread: string | null;
  via: readonly string[];
}

export interface HookTrace {
  plugin: string;
  action: HookAction;
}

export interface AuditRecord {
  at: number;
  op: string;
  kind: OpKind;
  caller: Caller;
  hooks: HookTrace[];
  outcome: OpOutcome;
  detail: string | null;
  durationMs: number;
  input: string | null;
}

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly plugin: string | null = null,
  ) {
    super(message);
    this.name = "OpError";
  }
}

class Denial extends Error {}

export class ToolFailure extends Error {}

export function toolError(text: string): never {
  throw new ToolFailure(text);
}

export function deny(reason: string): never {
  throw new Denial(reason);
}

type MaybePromise<T> = T | Promise<T>;
type In<O extends Op> = z.output<O["input"]>;
type Out<O extends Op> = z.output<O["output"]>;
type ValueOf<L extends Live> = z.output<L["value"]>;

export interface Next<Input, Output> {
  (input?: Input): Promise<Output>;
  readonly origin: Caller;
}
export type Hook<Input, Output> = (
  input: Input,
  next: Next<Input, Output>,
) => MaybePromise<Output>;
export interface CallContext {
  caller: Caller;
  signal: AbortSignal;
}
export type Implementation<Input, Output> = (
  input: Input,
  context: CallContext,
) => MaybePromise<Output>;
export type Listener<Payload> = (payload: Payload) => unknown;
export interface Registration {
  failClosed(): Registration;
}
export interface CallOptions {
  signal?: AbortSignal;
}
export interface SlotEntryView<Item> {
  plugin: string;
  item: Item;
}
export interface LiveHandle<Value> {
  get(): Value;
  set(value: Value): void;
  update(change: (value: Value) => Value): void;
}

export interface OpCalls {
  call<O extends Op>(
    op: O,
    input: z.input<O["input"]>,
    options?: CallOptions,
  ): Promise<Out<O>>;
  emit<E extends EventDef>(event: E, payload: z.input<E["payload"]>): void;
  read<Item>(slot: Slot<Item>): Item[];
  entries<Item>(slot: Slot<Item>): SlotEntryView<Item>[];
  find<Item>(slot: Slot<Item>, key: string): Item | null;
  pick<Item>(slot: Slot<Item>): Item | null;
  use<Item>(slot: Slot<Item>): Item;
  value<L extends Live>(live: L): ValueOf<L> | undefined;
  changed(member: Op | Live): void;
}

export interface PluginVerbs extends OpCalls {
  implement<O extends Op>(
    op: O,
    run: Implementation<In<O>, z.input<O["output"]>>,
  ): void;
  on<O extends Op>(op: O, hook: Hook<In<O>, Out<O>>): Registration;
  on<O extends Op>(
    op: O,
    matcher: Partial<In<O>>,
    hook: Hook<In<O>, Out<O>>,
  ): Registration;
  on<E extends EventDef>(
    event: E,
    listener: Listener<z.output<E["payload"]>>,
  ): Registration;
  add<Item>(slot: Slot<Item>, item: Item): () => void;
  wrap<Item>(
    slot: Slot<Item>,
    matcher: Partial<Item> | null,
    change: (item: Item) => Item,
  ): void;
  provide<L extends Live>(
    live: L,
    initial: z.input<L["value"]>,
  ): LiveHandle<ValueOf<L>>;
}

export interface PluginScope extends PluginVerbs {
  dispose(): void;
}

export interface KernelInspection {
  ops: {
    name: string;
    kind: OpKind;
    hooks: HookPower;
    allow: Allow;
    owner: string | null;
    doors: string[];
    chain: { plugin: string; tier: Tier; failClosed: boolean }[];
  }[];
  events: { name: string; listeners: string[] }[];
  slots: { name: string; pick: "one" | "many"; entries: string[] }[];
  live: { name: string; owner: string }[];
  plugins: { id: string; tier: Tier }[];
}

export interface Kernel extends OpCalls {
  scope(plugin: string, tier: Tier): PluginScope;
  op(name: string): Op | null;
  ops(): { op: Op; owner: string | null }[];
  live(name: string): Live | null;
  watch(listener: () => void): () => void;
  version(): number;
  inspect(): KernelInspection;
}

export interface KernelOptions {
  currentCaller(): Caller;
  enter<T>(caller: Caller, work: () => T): T;
  record(entry: AuditRecord): void;
  now(): number;
  warn(message: string, fields: Record<string, unknown>): void;
  changed?(name: string): void;
  hookBudgetMs?: number;
}

type AnyHook = Hook<unknown, unknown>;
type Matcher = Record<string, unknown>;

interface HookEntry {
  plugin: string;
  tier: Tier;
  order: number;
  matcher: Matcher | null;
  run: AnyHook;
  failClosed: boolean;
}

interface OpState {
  op: Op;
  owner: { plugin: string; run: Implementation<unknown, unknown> } | null;
  chain: HookEntry[];
}

interface ListenerEntry {
  plugin: string;
  run: Listener<unknown>;
}

interface AnySlot {
  readonly name: string;
  readonly key: string | null;
  readonly pick: "one" | "many";
}

interface SlotEntry {
  plugin: string;
  tier: Tier;
  order: number;
  item: unknown;
}

interface WrapEntry {
  plugin: string;
  tier: Tier;
  order: number;
  matcher: Matcher | null;
  change: (item: unknown) => unknown;
}

interface SlotState {
  slot: AnySlot;
  entries: SlotEntry[];
  wraps: WrapEntry[];
  shown: { views: SlotEntryView<unknown>[]; items: unknown[] } | null;
}

interface LiveState {
  live: Live;
  owner: string;
  value: unknown;
}

const TIER_RANK: Record<Tier, number> = { policy: 0, installed: 1, product: 2 };
const INPUT_RECORD_LIMIT = 600;
const DEFAULT_HOOK_BUDGET_MS = 10_000;
const UNSETTLED = Symbol("unsettled");

function allowed(allow: Allow, role: CallerRole): boolean {
  return allow === "member" || role !== "member";
}

function matches(matcher: Matcher | null, input: unknown): boolean {
  if (matcher === null) return true;
  if (typeof input !== "object" || input === null) return false;
  const fields = input as Record<string, unknown>;
  return Object.entries(matcher).every(([key, value]) => fields[key] === value);
}

function describeInput(op: Op, input: unknown): string | null {
  if (input === undefined) return null;
  const redact = (key: string, value: unknown) =>
    op.secret.includes(key) ? "[secret]" : value;
  try {
    const text = JSON.stringify(input, redact) ?? null;
    if (text === null || text.length <= INPUT_RECORD_LIMIT) return text;
    return `${text.slice(0, INPUT_RECORD_LIMIT)}…`;
  } catch {
    return null;
  }
}

function issueMessage(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return "Invalid value";
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byTier<Entry extends { tier: Tier; order: number }>(
  entries: Entry[],
  outermost: Tier,
): Entry[] {
  const direction = outermost === "policy" ? 1 : -1;
  return [...entries].sort(
    (a, b) =>
      direction * (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || a.order - b.order,
  );
}

function stopwatch(budgetMs: number) {
  let spent = 0;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new Error(`ran past its ${budgetMs} ms budget`));
  });
  expired.catch(() => {});
  let stopped = false;
  const resume = () => {
    if (stopped) return;
    startedAt = Date.now();
    timer = setTimeout(expire, Math.max(budgetMs - spent, 0));
  };
  const pause = () => {
    clearTimeout(timer);
    spent += Date.now() - startedAt;
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  resume();
  return { expired, pause, resume, stop };
}

export function createKernel(options: KernelOptions): Kernel {
  const ops = new Map<string, OpState>();
  const listeners = new Map<string, ListenerEntry[]>();
  const slots = new Map<string, SlotState>();
  const lives = new Map<string, LiveState>();
  const watchers = new Set<() => void>();
  const scopes = new Map<string, { tier: Tier; count: number }>();
  const budgetMs = options.hookBudgetMs ?? DEFAULT_HOOK_BUDGET_MS;
  const NEVER_ABORTED = new AbortController().signal;
  let order = 0;
  let version = 0;

  const stateOf = (op: Op): OpState => {
    const known = ops.get(op.name);
    if (known !== undefined) return known;
    const created: OpState = { op, owner: null, chain: [] };
    ops.set(op.name, created);
    return created;
  };

  const slotOf = (slot: AnySlot): SlotState => {
    const known = slots.get(slot.name);
    if (known !== undefined) return known;
    const created: SlotState = { slot, entries: [], wraps: [], shown: null };
    slots.set(slot.name, created);
    return created;
  };

  const touched = (state: SlotState) => {
    state.shown = null;
    version += 1;
    for (const watcher of [...watchers]) watcher();
  };

  const shownOf = (slot: AnySlot) => {
    const state = slotOf(slot);
    if (state.shown !== null) return state.shown;
    const { key, pick } = state.slot;
    const ranked = byTier(state.entries, "product");
    let winners = pick === "one" ? ranked.slice(-1) : state.entries;
    if (pick === "many" && key !== null) {
      const byKey = new Map<unknown, SlotEntry>();
      for (const entry of ranked) {
        byKey.set((entry.item as Record<string, unknown>)[key], entry);
      }
      winners = [...byKey.values()];
    }
    const wraps = byTier(state.wraps, "product");
    const views = winners.map(({ plugin, item }) => {
      let shown = item;
      for (const wrap of wraps) {
        if (!matches(wrap.matcher, shown)) continue;
        try {
          shown = wrap.change(shown);
        } catch (error) {
          const fields = { plugin: wrap.plugin, slot: slot.name };
          const reason = messageOf(error);
          options.warn("A slot wrapper failed", { ...fields, reason });
        }
      }
      return { plugin, item: shown };
    });
    state.shown = { views, items: views.map(({ item }) => item) };
    return state.shown;
  };

  async function run(
    op: Op,
    raw: unknown,
    caller: Caller,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!allowed(op.allow, caller.role)) {
      throw new OpError("forbidden", `Only an owner may call ${op.name}`);
    }
    const accepted = await op.input.safeParseAsync(raw);
    if (!accepted.success) {
      const problem = issueMessage(accepted.error);
      throw new OpError("invalid_input", `${op.name}: ${problem}`);
    }
    const state = stateOf(op);
    const chain = byTier(state.chain, "policy");
    const traces: HookTrace[] = [];
    const owner = async (input: unknown): Promise<unknown> => {
      if (state.owner === null) {
        throw new OpError("unimplemented", `Nothing implements ${op.name}`);
      }
      return state.owner.run(input, { caller, signal });
    };
    const dispatch = async (
      index: number,
      input: unknown,
    ): Promise<unknown> => {
      const entry = chain[index];
      if (entry === undefined) return owner(input);
      if (!matches(entry.matcher, input)) return dispatch(index + 1, input);
      const { plugin } = entry;
      const flight: { beneath: Promise<unknown> | null } = { beneath: null };
      const watch = stopwatch(budgetMs);
      const forward = (replacement: unknown = input) => {
        if (flight.beneath !== null) return flight.beneath;
        const passed = op.hooks === "observe" ? input : replacement;
        if (passed !== input) traces.push({ plugin, action: "rewrote-input" });
        watch.pause();
        const beneath = dispatch(index + 1, passed);
        beneath.then(watch.resume, watch.resume);
        flight.beneath = beneath;
        return beneath;
      };
      const next = Object.assign(forward, { origin: caller });
      try {
        const hooked = Promise.resolve(entry.run(input, next));
        const answer = await Promise.race([hooked, watch.expired]);
        if (flight.beneath === null) {
          if (op.hooks !== "answer") {
            throw new Error(`a hook on ${op.name} must call next`);
          }
          traces.push({ plugin, action: "answered" });
          return answer;
        }
        const result = await flight.beneath;
        if (op.hooks === "observe") return result;
        if (answer !== result) {
          traces.push({ plugin, action: "rewrote-output" });
        }
        return answer;
      } catch (error) {
        const pending = flight.beneath;
        const failure =
          pending === null
            ? UNSETTLED
            : await pending.then(
                () => UNSETTLED,
                (reason: unknown) => reason,
              );
        if (failure !== UNSETTLED && failure === error) throw error;
        const refusable = op.hooks === "answer";
        if (error instanceof Denial && refusable) {
          traces.push({ plugin, action: "denied" });
          throw new OpError("denied", error.message, plugin);
        }
        const reason = messageOf(error);
        options.warn("A plugin hook failed", { plugin, op: op.name, reason });
        if (entry.failClosed) {
          traces.push({ plugin, action: "denied" });
          const message = `${plugin} could not check ${op.name}: ${reason}`;
          throw new OpError("denied", message, plugin);
        }
        traces.push({ plugin, action: "failed" });
        return pending ?? dispatch(index + 1, input);
      } finally {
        watch.stop();
      }
    };
    const startedAt = options.now();
    const finish = (outcome: OpOutcome, detail: string | null) => {
      const decided = traces.some(
        ({ action }) => action === "answered" || action === "denied",
      );
      if (op.kind === "read" && outcome === "ok" && !decided) return;
      options.record({
        at: startedAt,
        op: op.name,
        kind: op.kind,
        caller,
        hooks: traces,
        outcome,
        detail,
        durationMs: options.now() - startedAt,
        input: describeInput(op, accepted.data),
      });
    };
    let result: unknown;
    try {
      result = await dispatch(0, accepted.data);
    } catch (error) {
      const denied = error instanceof OpError && error.code === "denied";
      finish(denied ? "denied" : "error", messageOf(error));
      throw error;
    }
    const produced = await op.output.safeParseAsync(result);
    if (!produced.success) {
      const problem = `${op.name}: ${issueMessage(produced.error)}`;
      finish("error", problem);
      throw new OpError("invalid_output", problem);
    }
    finish("ok", null);
    return produced.data;
  }

  const calls = (caller: () => Caller): OpCalls => ({
    call<O extends Op>(
      op: O,
      input: z.input<O["input"]>,
      { signal = NEVER_ABORTED }: CallOptions = {},
    ) {
      return run(op, input, caller(), signal) as Promise<Out<O>>;
    },
    emit(event, payload) {
      const parsed = event.payload.safeParse(payload);
      if (!parsed.success) {
        const reason = issueMessage(parsed.error);
        const fields = { event: event.name, reason };
        options.warn("An event payload is invalid", fields);
        return;
      }
      for (const { plugin, run: listen } of listeners.get(event.name) ?? []) {
        const failed = (error: unknown) => {
          const reason = messageOf(error);
          const fields = { plugin, event: event.name, reason };
          options.warn("A plugin listener failed", fields);
        };
        try {
          void Promise.resolve(listen(parsed.data)).catch(failed);
        } catch (error) {
          failed(error);
        }
      }
    },
    read<Item>(slot: Slot<Item>): Item[] {
      return shownOf(slot).items as Item[];
    },
    entries<Item>(slot: Slot<Item>): SlotEntryView<Item>[] {
      return shownOf(slot).views as SlotEntryView<Item>[];
    },
    find<Item>(slot: Slot<Item>, wanted: string): Item | null {
      const { key } = slot;
      if (key === null) throw new Error(`${slot.name} is not a keyed slot`);
      const found = shownOf(slot).items.find(
        (item) => (item as Record<string, unknown>)[key] === wanted,
      );
      return found === undefined ? null : (found as Item);
    },
    pick<Item>(slot: Slot<Item>): Item | null {
      const last = shownOf(slot).items.at(-1);
      return last === undefined ? null : (last as Item);
    },
    use<Item>(slot: Slot<Item>): Item {
      const { items } = shownOf(slot);
      if (items.length === 0) throw new Error(`Nothing provides ${slot.name}`);
      return items.at(-1) as Item;
    },
    value<L extends Live>(live: L): ValueOf<L> | undefined {
      return lives.get(live.name)?.value as ValueOf<L> | undefined;
    },
    changed(member) {
      options.changed?.(member.name);
    },
  });

  const direct = calls(options.currentCaller);

  function scope(plugin: string, tier: Tier): PluginScope {
    const undo: (() => void)[] = [];
    let live = true;
    const known = scopes.get(plugin) ?? { tier, count: 0 };
    known.count += 1;
    scopes.set(plugin, known);
    const alive = () => {
      if (!live) throw new Error(`Plugin "${plugin}" was unloaded`);
    };
    const drop =
      <T>(list: T[], entry: T, after: () => void = () => {}) =>
      () => {
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        after();
      };
    const through = (): Caller => {
      const caller = options.currentCaller();
      if (caller.via.at(-1) === plugin) return caller;
      return { ...caller, via: [...caller.via, plugin] };
    };
    const own = calls(through);
    return {
      ...direct,
      call<O extends Op>(
        op: O,
        input: z.input<O["input"]>,
        { signal = NEVER_ABORTED }: CallOptions = {},
      ) {
        alive();
        const mine = ops.get(op.name)?.owner?.plugin === plugin;
        const caller = mine ? options.currentCaller() : through();
        const work = () => run(op, input, caller, signal) as Promise<Out<O>>;
        return options.enter(caller, work);
      },
      emit(event, payload) {
        alive();
        own.emit(event, payload);
      },
      implement(op, implementation) {
        alive();
        const state = stateOf(op);
        if (state.owner !== null) {
          const holder = state.owner.plugin;
          throw new Error(`${op.name} is already implemented by ${holder}`);
        }
        const owner = {
          plugin,
          run: implementation as Implementation<unknown, unknown>,
        };
        state.owner = owner;
        undo.push(() => {
          if (state.owner === owner) state.owner = null;
        });
      },
      on(target: Op | EventDef, second: unknown, third?: unknown) {
        alive();
        if (target.type === "event") {
          const entry = { plugin, run: second as Listener<unknown> };
          const list = listeners.get(target.name) ?? [];
          listeners.set(target.name, list);
          list.push(entry);
          undo.push(drop(list, entry));
          const registration: Registration = {
            failClosed: () => registration,
          };
          return registration;
        }
        const state = stateOf(target);
        const hook = (third ?? second) as AnyHook;
        const matcher = third === undefined ? null : (second as Matcher);
        order += 1;
        const entry: HookEntry = {
          plugin,
          tier,
          order,
          matcher,
          run: hook,
          failClosed: false,
        };
        state.chain.push(entry);
        undo.push(drop(state.chain, entry));
        const registration: Registration = {
          failClosed() {
            if (target.hooks !== "answer") {
              throw new Error(`${target.name} cannot be refused by a hook`);
            }
            entry.failClosed = true;
            return registration;
          },
        };
        return registration;
      },
      add(slot, item) {
        alive();
        const state = slotOf(slot);
        if (slot.check !== null) {
          const mine = state.entries
            .filter((entry) => entry.plugin === plugin)
            .map((entry) => entry.item as typeof item);
          const problem = slot.check(item, mine);
          if (problem !== null) throw new Error(`${slot.name}: ${problem}`);
        }
        order += 1;
        const entry: SlotEntry = { plugin, tier, order, item };
        state.entries.push(entry);
        const remove = drop(state.entries, entry, () => touched(state));
        undo.push(remove);
        touched(state);
        return remove;
      },
      wrap(slot, matcher, change) {
        alive();
        const state = slotOf(slot);
        order += 1;
        const entry: WrapEntry = {
          plugin,
          tier,
          order,
          matcher: matcher as Matcher | null,
          change: change as (item: unknown) => unknown,
        };
        state.wraps.push(entry);
        undo.push(drop(state.wraps, entry, () => touched(state)));
        touched(state);
      },
      provide<L extends Live>(definition: L, initial: z.input<L["value"]>) {
        alive();
        const held = lives.get(definition.name);
        if (held !== undefined) {
          const message = `${definition.name} is already provided`;
          throw new Error(`${message} by ${held.owner}`);
        }
        const state: LiveState = {
          live: definition,
          owner: plugin,
          value: definition.value.parse(initial),
        };
        lives.set(definition.name, state);
        undo.push(() => {
          if (lives.get(definition.name) === state) {
            lives.delete(definition.name);
          }
        });
        const set = (value: ValueOf<L>) => {
          alive();
          state.value = definition.value.parse(value);
          options.changed?.(definition.name);
        };
        return {
          get: () => state.value as ValueOf<L>,
          set,
          update: (change) => set(change(state.value as ValueOf<L>)),
        };
      },
      dispose() {
        if (!live) return;
        known.count -= 1;
        if (known.count === 0) scopes.delete(plugin);
        live = false;
        for (const revert of undo.reverse()) revert();
        undo.length = 0;
      },
    };
  }

  return {
    ...direct,
    scope,
    op: (name) => ops.get(name)?.op ?? null,
    ops: () =>
      [...ops.values()].map(({ op, owner }) => {
        return { op, owner: owner?.plugin ?? null };
      }),
    live: (name) => lives.get(name)?.live ?? null,
    watch(listener) {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    version: () => version,
    inspect() {
      return {
        ops: [...ops.values()].map(({ op, owner, chain }) => ({
          name: op.name,
          kind: op.kind,
          hooks: op.hooks,
          allow: op.allow,
          owner: owner?.plugin ?? null,
          doors: [...(op.internal ? [] : ["app"]), ...Object.keys(op.doors)],
          chain: chain.map(({ plugin, tier, failClosed }) => {
            return { plugin, tier, failClosed };
          }),
        })),
        events: [...listeners].map(([name, list]) => {
          return { name, listeners: list.map(({ plugin }) => plugin) };
        }),
        slots: [...slots.values()].map(({ slot, entries }) => ({
          name: slot.name,
          pick: slot.pick,
          entries: entries.map(({ plugin }) => plugin),
        })),
        live: [...lives.values()].map(({ live: { name }, owner }) => {
          return { name, owner };
        }),
        plugins: [...scopes].map(([id, { tier: held }]) => {
          return { id, tier: held };
        }),
      };
    },
  };
}
