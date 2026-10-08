import type { ServerContext } from "@bb/server-kit/context";
import type { OpenDatabase } from "@bb/server-kit/db/index";
import type { PluginHost } from "./plugins/host.js";

export interface HostContext extends ServerContext {
  db: OpenDatabase;
  plugins: PluginHost;
}
