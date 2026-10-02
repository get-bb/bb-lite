import { publicApiRoutes } from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { pick, type Http } from "../http.js";

type Abortable = { signal?: AbortSignal };
type Session = api.TerminalSession;

interface ThreadScope {
  cwd?: never;
  environmentId?: never;
  hostId?: never;
  kind: "thread";
  threadId: string;
}

interface EnvironmentScope {
  environmentId: string;
  cwd?: never;
  hostId?: never;
  kind: "environment";
  threadId?: never;
}

interface HostPathScope<Cwd> {
  cwd: Cwd;
  environmentId?: never;
  hostId: string;
  kind: "host_path";
  threadId?: never;
}

export type TerminalListScope =
  | ThreadScope
  | EnvironmentScope
  | (Omit<HostPathScope<string>, "cwd"> & { cwd?: string });

export type TerminalCreateScope =
  | ThreadScope
  | EnvironmentScope
  | HostPathScope<string | null>;

interface TerminalTarget {
  terminalId: string;
}

export interface TerminalsArea {
  close(
    args: TerminalTarget & { mode: "force" | "if-clean" },
  ): Promise<Session>;
  create(args: {
    cols: number;
    rows: number;
    scope: TerminalCreateScope;
    start?: api.CreateTerminalRequest["start"];
    title?: string;
  }): Promise<Session>;
  get(args: TerminalTarget & Abortable): Promise<Session>;
  input(
    args: TerminalTarget & Pick<api.TerminalInputRequest, "dataBase64">,
  ): Promise<Session>;
  list(
    args: Abortable & { scope: TerminalListScope },
  ): Promise<api.TerminalListResponse>;
  output(
    args: TerminalTarget & Abortable & api.TerminalOutputQuery,
  ): Promise<api.TerminalOutputResponse>;
  rename(
    args: TerminalTarget & Pick<api.UpdateTerminalRequest, "title">,
  ): Promise<Session>;
}

const FOREIGN_SELECTORS = {
  thread: ["environmentId", "hostId", "cwd"],
  environment: ["threadId", "hostId", "cwd"],
  host_path: ["threadId", "environmentId"],
} as const;

const AMBIGUOUS_SCOPE = {
  thread: "Thread terminal scope cannot include environment or host selectors.",
  environment:
    "Environment terminal scope cannot include thread or host selectors.",
  host_path:
    "Host terminal scope cannot include thread or environment selectors.",
};

function assertUnambiguousScope(
  scope: TerminalListScope | TerminalCreateScope,
) {
  const foreign = FOREIGN_SELECTORS[scope.kind];
  if (foreign.some((selector) => selector in scope)) {
    throw new Error(AMBIGUOUS_SCOPE[scope.kind]);
  }
}

function listQuery(scope: TerminalListScope): api.TerminalListQuery {
  assertUnambiguousScope(scope);
  if (scope.kind === "thread") return pick(scope, ["threadId"]);
  if (scope.kind === "environment") return pick(scope, ["environmentId"]);
  const { hostId, cwd } = scope;
  return { hostId, ...(cwd === undefined ? {} : { cwd }) };
}

function createTarget(scope: TerminalCreateScope): api.TerminalCreateTarget {
  assertUnambiguousScope(scope);
  if (scope.kind === "thread") return pick(scope, ["kind", "threadId"]);
  if (scope.kind === "environment") {
    return pick(scope, ["kind", "environmentId"]);
  }
  return pick(scope, ["kind", "hostId", "cwd"]);
}

export function createTerminalsArea(http: Http): TerminalsArea {
  const routes = publicApiRoutes.terminals;
  const at = (terminalId: string) => ({ param: { terminalId } });
  return {
    close: ({ terminalId, mode }) =>
      http.json(routes.close, {
        ...at(terminalId),
        json: { mode, reason: "user" },
      }),
    create({ scope, ...shape }) {
      const target = createTarget(scope);
      const size = pick(shape, ["cols", "rows", "start"]);
      const json = { ...size, target, title: shape.title };
      return http.json(routes.create, { json });
    },
    get: ({ terminalId, signal }) =>
      http.json(routes.get, at(terminalId), signal),
    input: ({ terminalId, dataBase64 }) =>
      http.json(routes.input, { ...at(terminalId), json: { dataBase64 } }),
    list: ({ scope, signal }) =>
      http.json(routes.list, { query: listQuery(scope) }, signal),
    output(args) {
      const query = pick(args, ["sinceSeq", "tailBytes", "limitChunks"]);
      const input = { ...at(args.terminalId), query };
      return http.json(routes.output, input, args.signal);
    },
    rename: ({ terminalId, title }) =>
      http.json(routes.update, { ...at(terminalId), json: { title } }),
  };
}
