import type { PluginServerApi } from "@bb/plugin";
import { probe } from "./contract.js";

export default function plugin(bb: PluginServerApi): void {
  bb.implement(probe.where, ({ hostId }) =>
    bb.machine(hostId).call(probe.sum, { a: 2, b: 3 }),
  );
}
