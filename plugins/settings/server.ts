import type { PluginServerApi } from "@bb/plugin";
import { implementSettings } from "./ops.js";

export default function settings(bb: PluginServerApi): void {
  implementSettings(bb);
}
