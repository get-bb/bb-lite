import type { PluginServerApi } from "@bb/plugin";
import type { ServerContext } from "../context.js";
import { ApiError } from "../http/errors.js";

export type PluginOutwardApi = Pick<
  PluginServerApi,
  "threads" | "projects" | "hosts" | "sections" | "files"
> & { requestInput: PluginServerApi["ui"]["requestInput"] };

export type PluginHostDeps = (pluginId: string) => PluginOutwardApi;

const unavailable = (surface: string) => async (): Promise<never> => {
  const message = `bb.${surface} is not connected to the thread engine`;
  throw new ApiError(503, "unavailable", message);
};

export function createPluginHostDeps(_ctx: ServerContext): PluginHostDeps {
  return () => ({
    threads: {
      spawn: unavailable("threads.spawn"),
      send: unavailable("threads.send"),
      get: unavailable("threads.get"),
      list: unavailable("threads.list"),
      stop: unavailable("threads.stop"),
      update: unavailable("threads.update"),
      output: unavailable("threads.output"),
      events: unavailable("threads.events"),
    },
    projects: { list: unavailable("projects.list") },
    hosts: { list: unavailable("hosts.list") },
    sections: {
      list: unavailable("sections.list"),
      create: unavailable("sections.create"),
    },
    files: {
      read: unavailable("files.read"),
      write: unavailable("files.write"),
    },
    requestInput: unavailable("ui.requestInput"),
  });
}
