import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSession } from "@bb/runner";
import { afterEach } from "vitest";
import type { AcpLaunchSpec, AcpRunnerAgent } from "../src/launch-spec.js";
import { createHarness, FAKE_AGENT, text } from "./adapter-harness.js";

export interface LaunchArgs {
  dialect?: string;
  parameterizedModelPicker?: boolean;
  primaryModels?: string[];
  reasoningProbePriorityModelIds?: string[];
  env?: Record<string, string>;
  modelLines?: string;
  modelListArgs?: string[];
  selectFlag?: string;
  cliPrimaryModels?: string[];
  command?: string;
  args?: string[];
  launch?: Partial<AcpLaunchSpec>;
}

export function agentFor(args: LaunchArgs = {}): Partial<AcpRunnerAgent> {
  const baseArgs = args.args ?? [FAKE_AGENT];
  const lines = args.modelLines;
  const listArgs = args.modelListArgs ?? (lines === undefined ? undefined : []);
  const env = {
    ...args.env,
    ...(lines === undefined ? {} : { FAKE_ACP_MODEL_LINES: lines }),
  };
  const listFlag = lines === undefined ? [] : ["--list-models"];
  return {
    ...(args.dialect === undefined ? {} : { dialect: args.dialect }),
    ...(args.parameterizedModelPicker === true
      ? { parameterizedModelPicker: true }
      : {}),
    ...(args.primaryModels === undefined
      ? {}
      : { primaryModels: args.primaryModels }),
    ...(args.reasoningProbePriorityModelIds === undefined
      ? {}
      : {
          reasoningProbePriorityModelIds: args.reasoningProbePriorityModelIds,
        }),
    launch: {
      displayName: "Fake ACP",
      command: args.command ?? process.execPath,
      args: baseArgs,
      env,
      ...(listArgs === undefined
        ? {}
        : {
            modelCli: {
              listArgs: [
                ...baseArgs,
                ...(args.modelListArgs === undefined ? listFlag : listArgs),
              ],
              ...(args.selectFlag === undefined
                ? {}
                : { selectFlag: args.selectFlag }),
              primaryModels: args.cliPrimaryModels ?? [],
            },
          }),
      ...args.launch,
    },
  };
}

export function harnessFor(
  args: LaunchArgs = {},
  extra: Parameters<typeof createHarness>[0] = {},
) {
  return createHarness({ ...extra, agent: agentFor(args) });
}

export function listModels(args: LaunchArgs = {}) {
  return harnessFor(args).adapter.listModels(null);
}

const sessions: ProviderSession[] = [];

export function closeSessionsAfterEach() {
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close();
  });
}

export type Harness = ReturnType<typeof createHarness>;

export async function openWith(
  harness: Harness,
  execution: Partial<Harness["execution"]> = {},
) {
  Object.assign(harness.execution, execution);
  const session = await harness.open();
  sessions.push(session);
  return session;
}

let requests = 0;

export async function startTurn(
  harness: Harness,
  session: ProviderSession,
  prompt: string,
  execution: Partial<Harness["execution"]> = {},
) {
  requests += 1;
  return session.startTurn({
    clientRequestId: `req_models_${requests}`,
    input: text(prompt),
    options: { ...harness.execution, ...execution },
  });
}

export interface LoggedAcpRequest {
  method?: string;
  params?: Record<string, unknown>;
}

export function loggedLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

const logDir = mkdtempSync(join(tmpdir(), "bb-acp-models-"));

export function logPath(name: string) {
  return join(logDir, `${name}.jsonl`);
}

export function requestsTo(path: string, method: string) {
  return loggedLines<LoggedAcpRequest>(path).filter(
    (request) => request.method === method,
  );
}

export function configValues(path: string) {
  return requestsTo(path, "session/set_config_option").map(
    (request) => request.params?.["value"],
  );
}

export function agentTexts(harness: Harness) {
  return harness
    .items()
    .flatMap((item) => (item.type === "agentMessage" ? [item.text] : []));
}

export function effortIds(model: {
  supportedReasoningEfforts: { reasoningEffort: string }[];
}) {
  return model.supportedReasoningEfforts.map((e) => e.reasoningEffort);
}
