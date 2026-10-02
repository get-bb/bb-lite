import { publicApiRoutes } from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { pick, type Http } from "../http.js";

type Abortable = { signal?: AbortSignal };

export type ProviderHostRoutingArgs =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

type ExecutionOptionsArgs = api.SystemExecutionOptionsQuery & Abortable;

export interface ProvidersArea {
  catalog(): Promise<api.SystemProviderCatalogEntry[]>;
  setEnabled(args: {
    providerId: string;
    enabled: boolean;
  }): Promise<api.SystemProviderCatalogEntry[]>;
  list(
    args?: ProviderHostRoutingArgs &
      Abortable & { capability?: api.SystemProvidersQuery["capability"] },
  ): Promise<api.SystemProviderInfo[]>;
  models(
    args?: ProviderHostRoutingArgs & Abortable & { providerId?: string },
  ): Promise<api.SystemExecutionOptionsResponse>;
}

export function readExecutionOptions(
  http: Http,
  args: ExecutionOptionsArgs = {},
): Promise<api.SystemExecutionOptionsResponse> {
  const query = pick(args, ["environmentId", "hostId", "providerId"]);
  const route = publicApiRoutes.system.executionOptions;
  return http.json(route, { query }, args.signal);
}

export function createProvidersArea(http: Http): ProvidersArea {
  const routes = publicApiRoutes.system;
  return {
    catalog: () => http.json(routes.providerCatalog, {}),
    setEnabled: ({ providerId, enabled }) =>
      http.json(routes.providerEnabled, {
        param: { id: providerId },
        json: { enabled },
      }),
    list(args = {}) {
      const query = pick(args, ["capability", "environmentId", "hostId"]);
      return http.json(routes.providers, { query }, args.signal);
    },
    models: (args) => readExecutionOptions(http, args),
  };
}
