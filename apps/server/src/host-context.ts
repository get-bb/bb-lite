import type { Kernel } from "@bb/plugin";
import type { ServerContext } from "@bb/server-kit/context";
import type { OpenDatabase } from "@bb/server-kit/db/index";
import type { Hub } from "@bb/server-kit/ws/hub";
import type { PluginHost } from "./plugins/host.js";

export interface HostContext extends ServerContext {
  db: OpenDatabase;
  hub: Hub;
  kernel: Kernel;
  tunnelToken: string;
  plugins: PluginHost;
}
