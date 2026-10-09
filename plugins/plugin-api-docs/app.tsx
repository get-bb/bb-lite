import * as appApi from "@bb/plugin/app";
import {
  shell,
  useOp,
  useSlotEntries,
  type PluginAppApi,
  type Slot,
} from "@bb/plugin/app";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { useMemo, useState } from "react";
import { pluginApi, type ApiContract, type ApiMember } from "./contract.js";

function collectAppSlots(): Map<string, Slot> {
  const found = new Map<string, Slot>();
  for (const value of Object.values(appApi)) {
    if (typeof value !== "object" || value === null) continue;
    for (const member of Object.values(value)) {
      const candidate = member as Partial<Slot> | null;
      if (candidate?.type === "slot" && typeof candidate.name === "string") {
        found.set(candidate.name, candidate as Slot);
      }
    }
  }
  return found;
}

const APP_SLOTS = collectAppSlots();

function AppContributors({ slot }: { slot: Slot }) {
  const entries = useSlotEntries(slot);
  const plugins = [...new Set(entries.map(({ plugin }) => plugin))];
  return (
    <Fact
      label="Filled in the app by"
      value={plugins.length === 0 ? "nobody" : plugins.join(", ")}
    />
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-mono text-xs leading-5">
        {value}
      </span>
    </div>
  );
}

function MemberCard({ member }: { member: ApiMember }) {
  const appSlot = member.type === "slot" ? APP_SLOTS.get(member.name) : null;
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h3 className="font-mono text-sm font-medium text-foreground">
        {member.name}
        <span className="ml-2 font-sans text-xs text-muted-foreground">
          {member.type}
        </span>
      </h3>
      {member.facts.map((fact) => (
        <Fact key={fact.label} label={fact.label} value={fact.value} />
      ))}
      {appSlot ? <AppContributors slot={appSlot} /> : null}
      {member.shapes.map(({ label, shape }) => (
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

function matching(contracts: ApiContract[], query: string): ApiContract[] {
  const word = query.trim().toLowerCase();
  if (word === "") return contracts;
  return contracts.flatMap((group) => {
    if (group.name.toLowerCase().includes(word)) return [group];
    const members = group.members.filter(({ name }) =>
      name.toLowerCase().includes(word),
    );
    return members.length === 0 ? [] : [{ ...group, members }];
  });
}

function PluginApiPage() {
  const { status, data, error } = useOp(pluginApi.list, {});
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const shown = useMemo(
    () => matching(data?.contracts ?? [], query),
    [data, query],
  );
  if (status === "error") {
    return (
      <p className="p-4 text-sm text-destructive">
        {error?.message ?? "The plugin API could not be read."}
      </p>
    );
  }
  if (data === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  const current =
    shown.find(({ name }) => name === selected) ?? shown[0] ?? null;
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 p-3">
          <p className="text-xs text-muted-foreground">
            Plugin API {data.api}, {data.plugins.length} plugins loaded
          </p>
          <Input
            value={query}
            placeholder="Search contracts and members"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {shown.map(({ name, members }) => (
            <button
              key={name}
              type="button"
              onClick={() => setSelected(name)}
              className={cn(
                "flex w-full justify-between rounded px-2 py-1 text-left text-sm hover:bg-muted",
                current?.name === name && "bg-muted font-medium",
              )}
            >
              <span className="truncate font-mono">{name}</span>
              <span className="text-xs text-muted-foreground">
                {members.length}
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
        {current === null ? (
          <p className="text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          current.members.map((member) => (
            <MemberCard key={member.name} member={member} />
          ))
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
