import {
  publicApiRoutes,
  threadSectionMutationResponseSchema,
  threadSectionSchema,
} from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import type { Http } from "../http.js";

type Mutation = api.ThreadSectionMutationResponse;

export interface ThreadSectionsArea {
  create(
    args: api.CreateThreadSectionRequest,
  ): Promise<api.ThreadSectionResponse>;
  delete(args: api.DeleteThreadSectionRequest): Promise<Mutation>;
  list(args?: { signal?: AbortSignal }): Promise<api.ThreadSectionResponse[]>;
  update(args: api.UpdateThreadSectionRequest): Promise<Mutation>;
}

export function createThreadSectionsArea(http: Http): ThreadSectionsArea {
  const routes = publicApiRoutes.threadSections;
  return {
    async create(json) {
      const body = await http.json(routes.create, { json });
      return threadSectionSchema.parse(body);
    },
    async delete(json) {
      const body = await http.json(routes.delete, { json });
      return threadSectionMutationResponseSchema.parse(body);
    },
    async list(args) {
      const body = await http.json(routes.list, {}, args?.signal);
      return threadSectionSchema.array().parse(body);
    },
    async update(json) {
      const body = await http.json(routes.update, { json });
      return threadSectionMutationResponseSchema.parse(body);
    },
  };
}
