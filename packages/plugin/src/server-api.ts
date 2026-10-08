import type * as Domain from "@bb/domain";
import type * as Contract from "@bb/server-contract";
import type Database from "better-sqlite3";
import type { z } from "zod";
import type { CliRegistration } from "./cli.js";
import type { Op, Slot, TableRef } from "./contract.js";
import type { PluginVerbs } from "./kernel.js";

type MaybePromise<T> = T | Promise<T>;
type Thread = Contract.ThreadResponse;
type Presentation = Domain.ThreadEventItemPresentation;
type LogLevel = "debug" | "info" | "warn" | "error";

export type SettingDescriptor = Contract.PluginSettingDescriptor;
export type SettingDescriptors = Record<string, SettingDescriptor>;
export type SettingValue = string | boolean;
type ValueOf<Descriptor> = Descriptor extends { type: "boolean" }
  ? boolean
  : string;
export type SettingValues<D extends SettingDescriptors> = {
  [Key in keyof D]: D[Key] extends { default: SettingValue }
    ? ValueOf<D[Key]>
    : ValueOf<D[Key]> | undefined;
};
type SettingsUpdate<D> = { [Key in keyof D]?: ValueOf<D[Key]> | null };
type SettingsListener<Values> = (next: Values, previous: Values) => void;
export type SettingScope = "workspace" | "user";

export interface SettingsHandle<D extends SettingDescriptors> {
  get(): Promise<SettingValues<D>>;
  set(values: SettingsUpdate<D>): Promise<SettingValues<D>>;
  onChange(listener: SettingsListener<SettingValues<D>>): void;
}

export interface PluginKv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export type HttpAuth = "local" | "token" | "none";
export type HttpHandler = (request: Request) => MaybePromise<Response>;

export interface PluginEvents {
  "thread.created": { thread: Thread };
  "thread.active": { thread: Thread };
  "thread.idle": { thread: Thread; lastAssistantText: string | null };
  "thread.failed": { thread: Thread; error: string | null };
  "thread.archived": { thread: Thread };
  "thread.unarchived": { thread: Thread };
  "thread.deleted": { thread: Thread };
  "interaction.pending": {
    thread: Thread;
    interaction: Domain.PendingInteraction;
  };
}

export interface ThreadContext {
  threadId: string;
  projectId: string;
  hostId: string | null;
  providerId: string;
  providerCapabilities?: Domain.ProviderCapabilities;
}

export interface InputRequest {
  threadId: string;
  rendererId: string;
  title: string;
  payload: Domain.JsonValue;
  timeoutMs?: number;
  signal?: AbortSignal;
  presentation?: Partial<Presentation>;
  describeSubmission?(
    value: Domain.JsonValue,
  ): Domain.PluginInteractionDescription;
}
export type InputResult =
  | { outcome: "submitted"; value: Domain.JsonValue }
  | { outcome: "cancelled"; reason: string };

export interface MentionQuery {
  trigger: Contract.PluginMentionTrigger;
  query: string;
  projectId: string | null;
  threadId: string | null;
}
export interface MentionProvider {
  id: string;
  label: string;
  triggers?: readonly Contract.PluginMentionTrigger[];
  search(
    query: MentionQuery,
  ): MaybePromise<
    { id: string; title: string; subtitle?: string; icon?: string }[]
  >;
  resolve(itemId: string): MaybePromise<{ context: string }>;
}

export interface ProviderEnvEntry {
  name: string;
  value: string | { serverPath: string };
}

export interface EnvironmentContext {
  thread: Thread;
  project: Domain.Project;
  host: Domain.Host;
  checkoutPath: string | null;
  branchName: string;
  inputs: Domain.JsonValue | null;
  machine: { providerId: string; inputs: Domain.JsonValue | null } | null;
  resource: Domain.JsonValue | null;
  report(text: string, status?: "started" | "completed" | "failed"): void;
  signal: AbortSignal;
}

export interface EnvironmentResult {
  path: string;
  hostId?: string;
  resource?: Domain.JsonValue;
  branchName?: string;
}

export interface EnvironmentRemoval {
  hostId: string;
  path: string;
  resource: Domain.JsonValue | null;
}

export interface EnvironmentRequirements {
  projectCheckout: boolean;
  gitCheckout: boolean;
  gitRemote: boolean;
  projectless: boolean;
}

export interface EnvironmentDefinition {
  id: string;
  displayName: string;
  description?: string;
  icon?: string;
  requires?: EnvironmentRequirements;
  inputs?: Domain.JsonValue | null;
  validate?(
    inputs: Domain.JsonValue | null,
    context: { projectId: string; hostId: string },
  ): MaybePromise<string | null>;
  create(context: EnvironmentContext): Promise<EnvironmentResult>;
  remove(context: EnvironmentRemoval): Promise<void>;
}

export interface InferenceService {
  id: string;
  displayName: string;
  complete(prompt: string, options: { signal: AbortSignal }): Promise<string>;
}

export interface FileReadArgs {
  threadId: string;
  path: string;
  encoding?: "utf8" | "base64";
}
export interface FileWriteArgs extends FileReadArgs {
  content: string;
  expectedSha256?: string | null;
  mode?: number;
}

export interface MachineAccess {
  serverUrl: string;
  headers: Record<string, string>;
}
export interface MachineAccessProvider {
  grant(hostId: string): Promise<MachineAccess | null>;
  revoke(host: { id: string; connectMachineId: string | null }): Promise<void>;
}

export interface MachineCalls {
  call<O extends Op>(
    op: O,
    input: z.input<O["input"]>,
  ): Promise<z.output<O["output"]>>;
}

export type SqlValue = string | number | bigint | Buffer | null;

export interface PluginTables {
  name(local: string): string;
  migrate(statements: string[]): void;
  publish<Row>(table: Slot<TableRef<Row>>, local: string): void;
  of<Row>(table: Slot<TableRef<Row>>): string;
  all<Row = unknown>(sql: string, ...params: SqlValue[]): Row[];
  get<Row = unknown>(sql: string, ...params: SqlValue[]): Row | undefined;
  run(sql: string, ...params: SqlValue[]): { changes: number };
}

export interface PluginServerApi extends PluginVerbs {
  readonly pluginId: string;
  readonly log: Record<LogLevel, (message: string) => void>;
  readonly dataDir: string;
  readonly settings: {
    define<D extends SettingDescriptors>(
      descriptors: D,
      options?: { scope?: SettingScope },
    ): SettingsHandle<D>;
  };
  readonly storage: {
    kv: PluginKv;
    database(): Database.Database;
    migrate(database: Database.Database, statements: string[]): void;
    tables: PluginTables;
  };
  readonly http: {
    route(
      method: string,
      path: string,
      handler: HttpHandler,
      options?: { auth?: HttpAuth },
    ): void;
  };
  readonly background: {
    service(
      name: string,
      service: { start(signal: AbortSignal): MaybePromise<void> },
    ): void;
  };
  readonly cli: { register(registration: CliRegistration): void };
  machine(hostId: string): MachineCalls;
  readonly status: { needsConfiguration(message: string): void };
  readonly server: {
    url: string;
    dataDir: string;
    tunnelToken: string;
  };
  onStart(start: () => MaybePromise<void | (() => MaybePromise<void>)>): void;
  onDispose(dispose: () => MaybePromise<void>): void;
}

export type PluginServerEntry = (bb: PluginServerApi) => MaybePromise<void>;
