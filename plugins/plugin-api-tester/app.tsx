import { shell, useOp, type PluginAppApi } from "@bb/plugin/app";
import { apiTester } from "./contract.js";

function PluginApiTesterPanel() {
  const { status, data, error } = useOp(apiTester.status, {});
  const message =
    status === "ready" && data !== undefined
      ? `The ${data.pluginId}.status operation answered through the ${data.door} door.`
      : status === "error"
        ? `The status operation failed: ${error?.message ?? "unknown error"}`
        : "Calling the status operation…";
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">
            Plugin API Tester is active
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
        </div>
      </div>
    </div>
  );
}

export default function pluginApiTesterApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "plugin-api-tester",
    title: "Plugin API Tester",
    icon: "Beaker",
    path: "plugin-api-tester",
    view: PluginApiTesterPanel,
  });
}
