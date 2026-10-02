import type * as Domain from "@bb/domain";
import type * as Contract from "@bb/server-contract";
import type Database from "better-sqlite3";
import type { z } from "zod";
import type { CliRegistration } from "./cli.js";
import type { RpcContract, RpcHandlers } from "./rpc.js";

type MaybePromise<T> = T | Promise<T>;
type Thread = Contract.ThreadResponse;
type Presentation = Domain.ThreadEventItemPresentation;
type LogLevel = "debug" | "info" | "warn" | "error";

export type SettingDescriptor = Contract.PluginSettingDescriptor;
export type SettingDescriptors = Record<string, SettingDescriptor>;
export type SettingValue = string | number | boolean;
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

export type AgentToolResult = string | { text: string; isError: boolean };
export interface AgentTool<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  instructions?: string;
  presentation?: Presentation;
  parameters: Schema;
  enabledFor?(context: ThreadContext): boolean;
  execute(
    input: z.output<Schema>,
    context: ThreadContext & { signal: AbortSignal },
  ): MaybePromise<AgentToolResult>;
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
  signal: AbortSignal;
}
export interface EnvironmentDefinition {
  id: string;
  displayName: string;
  icon?: string;
  create(context: EnvironmentContext): Promise<{ path: string }>;
  remove(context: { hostId: string; path: string }): Promise<void>;
}

export interface InferenceService {
  id: string;
  displayName: string;
  complete(prompt: string, options: { signal: AbortSignal }): Promise<string>;
}

export type SpawnThreadRequest = Omit<
  z.input<typeof Contract.createThreadRequestSchema>,
  "origin" | "originPluginId"
>;
export interface PluginThreads {
  spawn(request: SpawnThreadRequest): Promise<Thread>;
  send(
    threadId: string,
    request: Contract.SendMessageRequest,
  ): Promise<Contract.SendMessageResponse>;
  get(threadId: string): Promise<Thread | null>;
  list(query?: Contract.ThreadListQuery): Promise<Contract.ThreadListResponse>;
  stop(threadId: string): Promise<void>;
  update(
    threadId: string,
    patch: Contract.UpdateThreadRequest,
  ): Promise<Thread>;
  output(threadId: string): Promise<string | null>;
  events(
    threadId: string,
    afterSequence?: number,
  ): Promise<Domain.ThreadEvent[]>;
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
export interface PluginFiles {
  read(args: FileReadArgs): Promise<{ content: string; sha256: string } | null>;
  write(
    args: FileWriteArgs,
  ): Promise<{ outcome: "written"; sha256: string } | { outcome: "conflict" }>;
}

export interface MachineAccess {
  serverUrl: string;
  headers: Record<string, string>;
}
export interface MachineAccessProvider {
  grant(hostId: string): Promise<MachineAccess | null>;
  revoke(host: { id: string; connectMachineId: string | null }): Promise<void>;
}

export interface PluginSections {
  list(): Promise<Contract.ThreadSectionResponse[]>;
  create(name: string): Promise<Contract.ThreadSectionResponse>;
}

export interface PluginServerApi {
  readonly pluginId: string;
  readonly log: Record<LogLevel, (message: string) => void>;
  readonly dataDir: string;
  readonly settings: {
    define<D extends SettingDescriptors>(descriptors: D): SettingsHandle<D>;
  };
  readonly storage: {
    kv: PluginKv;
    database(): Database.Database;
    migrate(database: Database.Database, statements: string[]): void;
  };
  readonly rpc: {
    register<Methods extends RpcContract>(
      contract: Methods,
      handlers: RpcHandlers<Methods>,
    ): void;
  };
  readonly http: {
    route(
      method: string,
      path: string,
      handler: HttpHandler,
      options?: { auth?: HttpAuth },
    ): void;
  };
  readonly realtime: { publish(channel: string, payload: unknown): void };
  readonly background: {
    service(
      name: string,
      service: { start(signal: AbortSignal): MaybePromise<void> },
    ): void;
  };
  readonly cli: { register(registration: CliRegistration): void };
  readonly events: {
    on<Name extends keyof PluginEvents>(
      name: Name,
      handler: (payload: PluginEvents[Name]) => MaybePromise<void>,
    ): void;
  };
  readonly agents: {
    registerTool<Schema extends z.ZodType>(tool: AgentTool<Schema>): void;
    contributeInstructions(
      contribute: (context: ThreadContext) => MaybePromise<string | null>,
    ): void;
  };
  readonly ui: {
    requestInput(request: InputRequest): Promise<InputResult>;
    registerMentionProvider(provider: MentionProvider): void;
  };
  readonly providers: {
    contributeEnv(
      providerId: string,
      contribute: (context: ThreadContext) => MaybePromise<ProviderEnvEntry[]>,
    ): void;
  };
  readonly environments: { register(definition: EnvironmentDefinition): void };
  readonly inference: { register(service: InferenceService): void };
  readonly threads: PluginThreads;
  readonly projects: { list(): Promise<Domain.Project[]> };
  readonly hosts: { list(): Promise<Domain.Host[]> };
  readonly machines: {
    setAccessProvider(provider: MachineAccessProvider | null): void;
  };
  readonly sections: PluginSections;
  readonly files: PluginFiles;
  readonly status: { needsConfiguration(message: string): void };
  readonly server: {
    url: string;
    dataDir: string;
    setPublicUrl(url: string | null): void;
  };
  onDispose(dispose: () => MaybePromise<void>): void;
}

export type PluginServerEntry = (bb: PluginServerApi) => MaybePromise<void>;
