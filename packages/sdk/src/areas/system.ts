import type * as domain from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import type { Http } from "../http.js";
import { readExecutionOptions } from "./providers.js";

type Abortable = { signal?: AbortSignal };
type Key = domain.UiPreferenceKey;

interface UiPreferenceWrite<K extends Key> {
  expectedRevision: number;
  key: K;
  value: domain.UiPreferenceValue<K>;
}

export interface SystemArea {
  machineEnvironment(): Promise<api.MachineEnvironmentList>;
  replaceMachineEnvironment(
    input: api.MachineEnvironmentReplace,
  ): Promise<api.MachineEnvironmentList>;
  config(args?: Abortable): Promise<api.SystemConfigResponse>;
  executionOptions(
    args?: api.SystemExecutionOptionsQuery & Abortable,
  ): Promise<api.SystemExecutionOptionsResponse>;
  uiPreferences: {
    list(args?: Abortable): Promise<api.UiPreferencesResponse>;
    set<K extends Key>(
      args: UiPreferenceWrite<K>,
    ): Promise<api.UiPreferenceResponse<K>>;
    reset<K extends Key>(args: {
      key: K;
    }): Promise<api.UiPreferenceResponse<K>>;
  };
  updateGeneralSettings(
    args: domain.AppSettingsUpdate,
  ): Promise<domain.AppSettings>;
  updateKeyboardSettings(
    args: domain.AppKeybindingOverrides,
  ): Promise<domain.AppKeybindingOverrides>;
}

export function createSystemArea(http: Http): SystemArea {
  const routes = publicApiRoutes.system;
  return {
    uiPreferences: {
      list: (args) => http.json(routes.uiPreferences, {}, args?.signal),
      async set<K extends Key>(args: UiPreferenceWrite<K>) {
        const { expectedRevision, key, value } = args;
        const input = { json: { expectedRevision, value }, param: { key } };
        const body = await http.json(routes.updateUiPreference, input);
        return body as api.UiPreferenceResponse<K>;
      },
      async reset<K extends Key>({ key }: { key: K }) {
        const input = { param: { key } };
        const body = await http.json(routes.resetUiPreference, input);
        return body as api.UiPreferenceResponse<K>;
      },
    },
    machineEnvironment: () => http.json(routes.machineEnvironment, {}),
    replaceMachineEnvironment: (json) =>
      http.json(routes.replaceMachineEnvironment, { json }),
    config: (args) => http.json(routes.config, {}, args?.signal),
    executionOptions: (args) => readExecutionOptions(http, args),
    updateGeneralSettings: (json) =>
      http.json(routes.generalSettings, { json }),
    updateKeyboardSettings: (json) =>
      http.json(routes.keyboardSettings, { json }),
  };
}
