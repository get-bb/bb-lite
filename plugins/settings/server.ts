import type { PluginServerApi } from "@bb/plugin";
import { coreOf } from "@bb/server-kit/host";
import { registerSettingsRoutes } from "./routes.js";

export default function settings(bb: PluginServerApi): void {
  coreOf(bb).routes(registerSettingsRoutes);
}
