import { settings, useCall, useOp, type PluginAppApi } from "@bb/plugin/app";
import { napGuard } from "./contract.js";

function Panel() {
  const state = useOp(napGuard.configuration, {});
  const update = useCall(napGuard.updateConfiguration);
  return (
    <button onClick={() => void update({ enabled: !state.data?.enabled })}>
      {state.data?.enabled ? "On" : "Off"}
    </button>
  );
}

export default function napGuardApp(bb: PluginAppApi): void {
  bb.add(settings.section, {
    id: "nap-guard",
    title: "Nap Guard",
    view: Panel,
  });
}
