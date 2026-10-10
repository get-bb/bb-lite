import type * as Domain from "@bb/domain";
import type { Runner, RunnerEvent, RunnerEventSink } from "@bb/runner";
import type * as Contract from "@bb/server-contract";
import type { IncomingHttpHeaders } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { WebSocket } from "ws";
import type { z } from "zod";
import type { CliRegistration } from "./cli.js";
import type { Op, Slot, TableRef } from "./contract.js";
import type { LogLevel, PluginBase } from "./base.js";

type MaybePromise<T> = T | Promise<T>;
type Thread = Contract.ThreadResponse;
type Presentation = Domain.ThreadEventItemPresentation;
export interface ServerConfig {
  dataDir: string;
  port: number;
  bindHost: string;
  allowedHosts: string[];
  profile: string;
  appDir: string;
  cliDir: string;
  version: string;
  hostId: string;
  logLevel: LogLevel;
  experiments?: Record<string, boolean>;
}

export type SettingDescriptor = Contract.PluginSettingDescriptor;
export type SettingDescriptors = Record<string, SettingDescriptor>;
export type SettingValue = string | boolean | number;
type ValueOf<Descriptor> = Descriptor extends { type: "boolean" }
  ? boolean
  : Descriptor extends { type: "number" }
    ? number
    : string;
export type SettingValues<D extends SettingDescriptors> = {
  [Key in keyof D]: D[Key] extends { default: SettingValue }
    ? ValueOf<D[Key]>
    : ValueOf<D[Key]> | undefined;
};
type SettingsUpdate<D> = { [Key in keyof D]?: ValueOf<D[Key]> | null };
type SettingsListener<Values> = (next: Values, previous: Values) => void;
export type SettingScope = "workspace" | "user" | "project";

export interface SettingsHandle<D extends SettingDescriptors> {
  get(options?: {
    userId?: string | null;
    projectId?: string | null;
  }): Promise<SettingValues<D>>;
  set(
    values: SettingsUpdate<D>,
    options?: { projectId?: string | null },
  ): Promise<SettingValues<D>>;
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

export interface ThreadFailure {
  code: string | null;
  message: string;
  detail: string | null;
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
  instanceKey: string;
  restoring: boolean;
  baseBranch: string | null;
  report(
    text: string,
    status?: "started" | "completed" | "failed",
    step?: { key?: string; startedAt?: number },
  ): void;
  log(line: string): void;
  signal: AbortSignal;
}

export interface EnvironmentResult {
  path: string;
  hostId?: string;
  resource?: Domain.JsonValue;
  branchName?: string;
  mergeBaseBranch?: string | null;
}

export type EnvironmentBranch =
  | { kind: "existing"; name: string }
  | { kind: "new"; baseBranch: string };

export type EnvironmentPlacement =
  | { type: "owned"; instanceKey?: string; baseBranch?: string | null }
  | {
      type: "checkout";
      kind?: string;
      path?: string;
      branch?: EnvironmentBranch;
    };

export interface EnvironmentDeletion {
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
  workspace?: Domain.WorkspaceProvisionType;
  default?: number;
  requires?: EnvironmentRequirements;
  inputs?: Domain.JsonValue | null;
  validate?(
    inputs: Domain.JsonValue | null,
    context: { projectId: string; hostId: string },
  ): MaybePromise<string | null>;
  place?(
    inputs: Domain.JsonValue | null,
    context: { threadId: string; projectId: string; hostId: string },
  ): MaybePromise<EnvironmentPlacement>;
  create(context: EnvironmentContext): Promise<EnvironmentResult>;
  delete(context: EnvironmentDeletion): Promise<void>;
}

export interface InferenceService {
  id: string;
  displayName: string;
  complete(prompt: string, options: { signal: AbortSignal }): Promise<string>;
}

export type FileSource = "workspace" | "thread-storage" | "host";
export interface FileReadArgs {
  threadId: string;
  path: string;
  encoding?: "utf8" | "base64";
  source?: FileSource;
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

export type SqlValue = string | number | bigint | Buffer | null;
export type RowValues = Record<string, SqlValue | undefined>;
export type SqlParams = SqlValue[] | [RowValues];

export interface SharedDatabase {
  now(): number;
  get<Row>(sql: string, ...params: SqlParams): Row | undefined;
  all<Row>(sql: string, ...params: SqlParams): Row[];
  run(sql: string, ...params: SqlParams): { changes: number };
  transaction<T>(work: () => T): T;
}

export type SubscriptionListener = (
  target: Domain.RealtimeSubscriptionTarget,
  subscribed: boolean,
) => void;
export type ChangeListener = (message: Domain.ChangedMessage) => void;

export interface Realtime {
  thread(
    id: string,
    changes: Domain.ThreadChangeKind[],
    metadata?: Domain.ThreadChangeMetadata,
  ): void;
  project(id: string, changes: Domain.ProjectChangeKind[]): void;
  environment(id: string, changes: Domain.EnvironmentChangeKind[]): void;
  host(id: string, changes: Domain.HostChangeKind[]): void;
  system(changes: Domain.SystemChangeKind[]): void;
  pluginSignal(
    pluginId: string,
    channel: string,
    payload: unknown,
    userId?: string,
  ): number;
  threadOpen(
    signal: Omit<Contract.ThreadOpenSignal, "type">,
    userId?: string | null,
  ): number;
  presence(): Domain.UserPresence[];
  onSubscriptionChange(listener: SubscriptionListener): () => void;
  onChanged(listener: ChangeListener): () => void;
}

export type RunnerEventKind = RunnerEvent["kind"];
export type RunnerEventOf<Kind extends RunnerEventKind> = Extract<
  RunnerEvent,
  { kind: Kind }
>;
export type RunnerEventHandler<Kind extends RunnerEventKind> = (
  event: RunnerEventOf<Kind>,
  hostId: string,
) => void | Promise<void>;
export type RunnerFactory<R> = (sink: RunnerEventSink) => R;

export interface Runners {
  readonly localHostId: string;
  get(hostId: string): Runner;
  connectedHostIds(): string[];
  isConnected(hostId: string): boolean;
  connect(hostId: string, create: RunnerFactory<Runner>): Runner;
  disconnect(hostId: string, runner?: Runner): void;
  onEvent<Kind extends RunnerEventKind>(
    kind: Kind,
    handler: RunnerEventHandler<Kind>,
  ): () => void;
  onConnected(listener: (hostId: string) => void): () => void;
  onDisconnected(listener: (hostId: string) => void): () => void;
  emit(hostId: string, event: RunnerEvent): Promise<void>;
  call<O extends Op>(
    hostId: string,
    op: O,
    input: z.input<O["input"]>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<z.output<O["output"]>>;
}

export type ApiEnv = { Bindings: HttpBindings };
export type ApiApp = Hono<ApiEnv>;
export type ApiRoutes = (app: ApiApp) => void;

export interface GateIdentity {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export type Principal =
  | { kind: "user"; userId: string; role: Domain.UserRole; implicit: boolean }
  | { kind: "runner"; hostId: string | null; connectMachineId: string | null }
  | { kind: "anonymous"; identity?: GateIdentity };

export interface Actor {
  userId: string;
  role: Domain.UserRole;
  agentThreadId: string | null;
}

export interface IncomingRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string };
}

export interface Authenticator {
  principal(request: IncomingRequest): Principal;
  actor(principal: Principal, threadId: string | undefined): Actor | null;
  owner(): Principal;
}

export interface SocketRequest {
  url: URL;
  principal: Principal;
  actor: Actor | null;
  header(name: string): string | undefined;
}
export type SocketOpen = (socket: WebSocket) => void;
export type SocketResolver = (request: SocketRequest) => SocketOpen | null;

export interface PluginTables {
  name(local: string): string;
  migrate(statements: string[]): void;
  publish<Row>(table: Slot<TableRef<Row>>, local: string): void;
  of<Row>(table: Slot<TableRef<Row>>): string;
}

export type ServerInfo = ServerConfig & { url: string; tunnelToken: string };

export interface PluginServerApi extends PluginBase {
  readonly dataDir: string;
  readonly server: ServerInfo;
  readonly db: SharedDatabase;
  readonly realtime: Realtime;
  readonly runners: Runners;
  now(): number;
  readonly settings: {
    define<D extends SettingDescriptors>(
      descriptors: D,
      options?: { scope?: SettingScope },
    ): SettingsHandle<D>;
  };
  readonly storage: {
    kv: PluginKv;
    database(migrations?: string[]): Database.Database;
    tables: PluginTables;
  };
  readonly http: {
    route(
      method: string,
      path: string,
      handler: HttpHandler,
      options?: { auth?: HttpAuth },
    ): void;
    api(routes: ApiRoutes, options?: { internal?: boolean }): void;
    socket(resolver: SocketResolver): void;
  };
  readonly background: {
    service(
      name: string,
      service: { start(signal: AbortSignal): MaybePromise<void> },
    ): void;
    schedule(
      name: string,
      cron: string,
      run: (signal: AbortSignal) => MaybePromise<void>,
    ): void;
  };
  readonly cli: { register(registration: CliRegistration): void };
  readonly status: { needsConfiguration(message: string): void; ready(): void };
}

export type PluginServerEntry = (bb: PluginServerApi) => MaybePromise<void>;
