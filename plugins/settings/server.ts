import type { PluginServerApi } from "@bb/plugin";
import { registerSettingsRoutes } from "./routes.js";

export default function settings(bb: PluginServerApi): void {
  bb.http.api((app) => registerSettingsRoutes(app, bb));
}
