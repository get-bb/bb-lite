import { definePluginApp, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { napGuardRpc } from "./server.js";

function Panel() {
  const rpc = useRpc(napGuardRpc);
  const settings = useSettings();
  return (
    <button onClick={() => rpc.setConfiguration({ enabled: true })}>
      {String(settings)}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "nap-guard",
    title: "Nap Guard",
    component: Panel,
  });
});
