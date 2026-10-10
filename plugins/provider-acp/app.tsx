import { useState } from "react";
import { settings, useCall, useOp, type PluginAppApi } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { acp } from "./contract.js";
import type { AcpRegistryView } from "./src/registry-view.js";

type RegistryAgent = AcpRegistryView["agents"][number];

const STATUS_TEXT: Record<RegistryAgent["status"], string> = {
  available: "",
  added: "Added",
  "update-available": "Update available",
  "built-in": "Built into bb",
  "manual-install": "Install it by hand",
};

function AgentRow(props: {
  agent: RegistryAgent;
  busy: boolean;
  onAdd(): void;
  onRemove(): void;
}) {
  const { agent, busy } = props;
  const canAdd =
    agent.status === "available" || agent.status === "update-available";
  const canRemove =
    agent.status === "added" || agent.status === "update-available";
  return (
    <li className="flex items-start gap-3 py-2">
      {agent.icon === null ? (
        <span className="size-5 shrink-0" />
      ) : (
        <img alt="" className="size-5 shrink-0" src={agent.icon} />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {agent.name}{" "}
          <span className="text-muted-foreground">{agent.version}</span>
        </div>
        {agent.description === "" ? null : (
          <p className="text-xs text-muted-foreground">{agent.description}</p>
        )}
        {STATUS_TEXT[agent.status] === "" ? null : (
          <p className="text-xs text-muted-foreground">
            {STATUS_TEXT[agent.status]}
          </p>
        )}
      </div>
      {canAdd ? (
        <Button size="sm" disabled={busy} onClick={props.onAdd}>
          {agent.status === "update-available" ? "Update" : "Add"}
        </Button>
      ) : null}
      {canRemove ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={props.onRemove}
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
}

function RegistrySettings() {
  const [refresh, setRefresh] = useState(false);
  const registry = useOp(acp.registry, { refresh });
  const add = useCall(acp.add);
  const remove = useCall(acp.remove);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await run();
      registry.refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };
  if (registry.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading registry…</p>;
  }
  const view = registry.data;
  const agents = view?.agents ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          Added agents run through npx or uvx on the machine that runs the
          thread.
        </p>
        <Button size="sm" variant="outline" onClick={() => setRefresh(true)}>
          Refresh
        </Button>
      </div>
      {view?.error ? (
        <p className="text-xs text-destructive">
          {agents.length === 0
            ? `Could not load the ACP registry: ${view.error}`
            : `Showing a saved copy: ${view.error}`}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="text-xs text-destructive">{error}</p>
      )}
      <ul className="divide-y divide-border">
        {agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            busy={busy !== null}
            onAdd={() => change(agent.id, () => add({ id: agent.id }))}
            onRemove={() => change(agent.id, () => remove({ id: agent.id }))}
          />
        ))}
      </ul>
    </div>
  );
}

export default function acpApp(bb: PluginAppApi): void {
  bb.add(settings.section, {
    id: "provider-acp-registry",
    title: "ACP registry",
    description:
      "Add agents from the official Agent Client Protocol registry as " +
      "providers.",
    view: RegistrySettings,
  });
}
