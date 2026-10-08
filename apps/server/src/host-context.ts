import type { ServerContext } from "@bb/server-kit/context";
import type { PluginHost } from "./plugins/host.js";

export interface HostContext extends ServerContext {
  plugins: PluginHost;
}
