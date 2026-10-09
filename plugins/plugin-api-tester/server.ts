import type { PluginServerApi } from "@bb/plugin";
import { apiTester } from "./contract.js";

export default function pluginApiTester(bb: PluginServerApi): void {
  bb.implement(apiTester.status, (_input, { caller }) => ({
    active: true,
    pluginId: bb.pluginId,
    door: caller.door,
  }));
}
