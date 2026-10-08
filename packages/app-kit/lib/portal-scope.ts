import { useContext } from "react";
import { PluginContext } from "../plugins/context";

export function usePortalScopeProps(): {
  "data-bb-portaled-overlay": "";
  "data-bb-plugin"?: string;
} {
  const pluginId = useContext(PluginContext);
  return pluginId === null
    ? { "data-bb-portaled-overlay": "" }
    : { "data-bb-portaled-overlay": "", "data-bb-plugin": pluginId };
}
