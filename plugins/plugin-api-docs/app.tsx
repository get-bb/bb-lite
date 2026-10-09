import { plugins } from "@bb/plugin";
import { describeApp, shell, useOp, type PluginAppApi } from "@bb/plugin/app";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { useMemo, useState } from "react";
import {
  matching,
  memberFacts,
  memberShapes,
  mergeContracts,
  sidesLabel,
  USES,
  type Contract,
  type Described,
  type Member,
} from "./reference.js";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-36 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-mono text-xs leading-5">
        {value}
      </span>
    </div>
  );
}

function MemberCard({ member, plugin }: { member: Member; plugin: string }) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h3 className="font-mono text-sm font-medium text-foreground">
        {member.name}
        <span className="ml-2 font-sans text-xs text-muted-foreground">
          {member.type}
        </span>
      </h3>
      {memberFacts(member, plugin).map((fact) => (
        <Fact key={fact.label} label={fact.label} value={fact.value} />
      ))}
      {memberShapes(member).map(({ label, shape }) => (
        <details key={label} className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {label}
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
            {JSON.stringify(shape, null, 2)}
          </pre>
        </details>
      ))}
    </section>
  );
}

function appUses(app: Described, id: string) {
  const fills = app.contracts.flatMap(({ id: contract, members }) =>
    Object.entries(members)
      .filter(([, member]) => {
        const filled = member.filledBy;
        return Array.isArray(filled) && filled.includes(id);
      })
      .map(([key]) => `${contract}.${key}`),
  );
  const declares = app.contracts
    .filter(({ plugin }) => plugin === id)
    .map(({ id: contract }) => contract);
  return { declares, fills };
}

function PluginView({ id, app }: { id: string; app: Described }) {
  const { data } = useOp(plugins.describe, { id });
  const inApp = appUses(app, id);
  const uses = data?.uses;
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h3 className="font-mono text-sm font-medium text-foreground">{id}</h3>
      {uses === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        USES.map(([key, label]) => (
          <Fact
            key={key}
            label={`${label} (server)`}
            value={uses[key].join(", ") || "nothing"}
          />
        ))
      )}
      <Fact
        label="Declares (app)"
        value={inApp.declares.join(", ") || "nothing"}
      />
      <Fact label="Fills (app)" value={inApp.fills.join(", ") || "nothing"} />
    </section>
  );
}

function SideNav({
  items,
  current,
  onSelect,
}: {
  items: { id: string; note: string }[];
  current: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {items.map(({ id, note }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          className={cn(
            "flex w-full justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted",
            current === id && "bg-muted font-medium",
          )}
        >
          <span className="truncate font-mono">{id}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{note}</span>
        </button>
      ))}
    </nav>
  );
}

function PluginApiPage() {
  const server = useOp(plugins.contracts, {});
  const inspected = useOp(plugins.inspect, {});
  const app = useMemo(() => describeApp(), []);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"contracts" | "plugins">("contracts");
  const [selected, setSelected] = useState<string | null>(null);
  const contracts = useMemo<Contract[]>(
    () =>
      server.data === undefined
        ? []
        : mergeContracts([
            { side: "server", described: server.data },
            { side: "app", described: app },
          ]),
    [server.data, app],
  );
  if (server.status === "error") {
    return (
      <p className="p-4 text-sm text-destructive">
        {server.error?.message ?? "The plugin API could not be read."}
      </p>
    );
  }
  if (server.data === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  const word = query.trim().toLowerCase();
  const shown = matching(contracts, query);
  const loaded = (inspected.data?.plugins ?? [])
    .map(({ id }) => id)
    .filter((id) => id.toLowerCase().includes(word))
    .sort();
  const current = shown.find(({ id }) => id === selected) ?? shown[0];
  const plugin = loaded.find((id) => id === selected) ?? loaded[0];
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 p-3">
          <p className="text-xs text-muted-foreground">
            Plugin API {server.data.api}
          </p>
          <div className="flex gap-1 text-sm">
            {(["contracts", "plugins"] as const).map((each) => (
              <button
                key={each}
                type="button"
                onClick={() => setView(each)}
                className={cn(
                  "rounded px-2 py-0.5 capitalize hover:bg-muted",
                  view === each && "bg-muted font-medium",
                )}
              >
                {each}
              </button>
            ))}
          </div>
          <Input
            value={query}
            placeholder={`Search ${view}`}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {view === "contracts" ? (
          <SideNav
            items={shown.map(({ id, members, sides }) => ({
              id,
              note: `${members.length} ${sides.includes("server") ? "" : "app"}`,
            }))}
            current={current?.id}
            onSelect={setSelected}
          />
        ) : (
          <SideNav
            items={loaded.map((id) => ({ id, note: "" }))}
            current={plugin}
            onSelect={setSelected}
          />
        )}
      </aside>
      <main className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
        {view === "plugins" ? (
          plugin === undefined ? (
            <p className="text-sm text-muted-foreground">Nothing matches.</p>
          ) : (
            <PluginView id={plugin} app={app} />
          )
        ) : current === undefined ? (
          <p className="text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {current.id}: {sidesLabel(current.sides)}, declared by{" "}
              {current.plugin}
            </p>
            {current.members.map((member) => (
              <MemberCard
                key={member.name}
                member={member}
                plugin={current.plugin}
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}

export default function pluginApiDocsApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "plugin-api",
    title: "Plugin Guide",
    icon: "Explore",
    path: "plugin-api",
    view: PluginApiPage,
  });
}
