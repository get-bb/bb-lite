import { useState } from "react";
import { settings, useCall, useOp, type PluginAppApi } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { marketplace, type Offered } from "./contract";

export default function marketplaceApp(bb: PluginAppApi): void {
  bb.add(settings.page, {
    id: "marketplace",
    label: "Marketplace",
    icon: "Store",
    order: 450,
    view: MarketplacePage,
  });
}

type Pending = { entry: Offered; action: "install" | "update" | "remove" };

function origin(entry: Offered): string[] {
  const facts = [`Source: ${entry.source}`];
  if (entry.subdir !== null) facts.push(`Directory: ${entry.subdir}`);
  if (entry.ref !== null) facts.push(`Ref: ${entry.ref}`);
  if (entry.range !== null) {
    const tags = entry.tagPrefix === null ? "" : ` (tags ${entry.tagPrefix}v*)`;
    facts.push(`Version: ${entry.range}${tags}`);
  }
  return facts;
}

function facts(entry: Offered): string[] {
  const parts =
    entry.parts === null
      ? "Parts: declared by the plugin"
      : `Parts: ${entry.parts.join(", ")}${entry.parts.some((part) => part !== "app") ? " (runs code on the server or teammates' machines)" : ""}`;
  return [
    parts,
    `bb API: ${entry.engine ?? "declared by the plugin"}`,
    ...(entry.author === null ? [] : [`By ${entry.author}`]),
  ];
}

function MarketplacePage() {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = useOp(marketplace.catalog, { query });
  const updates = useOp(marketplace.updates, {});
  const install = useCall(marketplace.install);
  const update = useCall(marketplace.update);
  const remove = useCall(marketplace.uninstall);
  const newer = new Map(
    (updates.data ?? []).map((row) => [row.id, row.latest]),
  );

  const confirm = async ({ entry, action }: Pending) => {
    setError(null);
    try {
      if (action === "install") await install({ id: entry.id });
      if (action === "update") await update({ id: entry.id });
      if (action === "remove") await remove({ id: entry.id });
      setPending(null);
      catalog.refetch();
      updates.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        placeholder="Search plugins"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {(catalog.data?.errors ?? []).map((problem) => (
        <p key={problem.catalog} className="text-sm text-destructive">
          {problem.catalog}: {problem.message}
        </p>
      ))}
      {pending !== null && (
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">
            {pending.action === "remove" ? "Remove" : "Install"}{" "}
            {pending.entry.name}?
          </p>
          {pending.action !== "remove" && (
            <p className="text-muted-foreground">
              This runs the plugin's code on this server and, for a runner part,
              on every connected machine.
            </p>
          )}
          {origin(pending.entry).map((line) => (
            <p key={line} className="font-mono text-xs">
              {line}
            </p>
          ))}
          {error !== null && <p className="text-destructive">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button onClick={() => void confirm(pending)}>Confirm</Button>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(catalog.data?.entries ?? []).map((entry) => {
        const latest = newer.get(entry.id);
        return (
          <div key={entry.id} className="flex gap-3 rounded-md border p-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <p className="font-medium">
                {entry.name}
                {entry.installed !== null &&
                  ` · installed ${entry.installed.version ?? ""}`}
              </p>
              <p>{entry.description}</p>
              {[...facts(entry), ...origin(entry)].map((line) => (
                <p key={line} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              {entry.installed === null && entry.installable && (
                <Button
                  onClick={() => setPending({ entry, action: "install" })}
                >
                  Install
                </Button>
              )}
              {latest !== undefined && (
                <Button onClick={() => setPending({ entry, action: "update" })}>
                  Update to {latest}
                </Button>
              )}
              {entry.installed !== null && (
                <Button
                  variant="outline"
                  onClick={() => setPending({ entry, action: "remove" })}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
