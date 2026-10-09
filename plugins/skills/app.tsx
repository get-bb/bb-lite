import {
  Markdown,
  shell,
  useCall,
  useChanged,
  useOp,
  type PluginAppApi,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { useState } from "react";
import { skills, type RegistrySkill, type Skill } from "./contract.js";

function SkillDetail({ id, onChange }: { id: string; onChange(): void }) {
  const detail = useOp(skills.get, { id });
  const enable = useCall(skills.enable);
  const disable = useCall(skills.disable);
  const uninstall = useCall(skills.uninstall);
  const skill = detail.data;
  if (skill === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  const after = (done: Promise<unknown>) =>
    void done.then(() => {
      detail.refetch();
      onChange();
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-medium">{skill.name}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            after(skill.enabled ? disable({ id }) : enable({ id }))
          }
        >
          {skill.enabled ? "Disable" : "Enable"}
        </Button>
        {skill.source === "installed" && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => after(uninstall({ id }))}
          >
            Remove
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {skill.source} · {skill.path}
      </p>
      <Markdown content={skill.content} />
      <p className="text-xs text-muted-foreground">{skill.files.join(" · ")}</p>
    </div>
  );
}

function Registry({
  query,
  onInstalled,
}: {
  query: string;
  onInstalled(): void;
}) {
  const found = useOp(skills.search, { query });
  const install = useCall(skills.install);
  const [busy, setBusy] = useState<string | null>(null);
  const add = (entry: RegistrySkill) => {
    setBusy(entry.id);
    const source = { source: entry.install };
    const named = entry.skill === undefined ? {} : { skill: entry.skill };
    void install({ ...source, ...named })
      .then(onInstalled)
      .finally(() => setBusy(null));
  };
  if (found.error !== null) {
    return (
      <p className="p-2 text-sm text-destructive">{found.error.message}</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {(found.data ?? []).map((entry) => (
        <li key={entry.id} className="flex items-center gap-2 p-2 text-sm">
          <span className="flex-1">
            <span className="font-medium">{entry.name}</span>{" "}
            <span className="text-muted-foreground">{entry.description}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => add(entry)}
          >
            Install
          </Button>
        </li>
      ))}
    </ul>
  );
}

function SkillRow(props: {
  skill: Skill;
  selected: boolean;
  onSelect(): void;
}) {
  const { skill } = props;
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full flex-col items-start rounded px-2 py-1 text-left text-sm",
        props.selected && "bg-accent",
        !skill.enabled && "opacity-50",
      )}
    >
      <span className="font-medium">{skill.name}</span>
      <span className="line-clamp-1 text-xs text-muted-foreground">
        {skill.source} · {skill.description ?? ""}
      </span>
    </button>
  );
}

function SkillsPage() {
  const all = useOp(skills.list, {});
  useChanged(skills.list, all.refetch);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const needle = query.trim().toLowerCase();
  const shown = (all.data ?? []).filter((skill) =>
    `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(needle),
  );
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 flex-col gap-2 overflow-auto border-r p-3">
        <Input
          placeholder="Search skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="sm"
          variant={browsing ? "secondary" : "ghost"}
          onClick={() => setBrowsing(!browsing)}
        >
          {browsing ? "Installed skills" : "Browse the registry"}
        </Button>
        {!browsing &&
          shown.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              selected={skill.id === selected}
              onSelect={() => setSelected(skill.id)}
            />
          ))}
      </aside>
      <main className="flex min-h-0 flex-1 flex-col overflow-auto">
        {browsing ? (
          <Registry query={query} onInstalled={all.refetch} />
        ) : selected === null ? (
          <p className="p-4 text-sm text-muted-foreground">
            Pick a skill to read it.
          </p>
        ) : (
          <SkillDetail key={selected} id={selected} onChange={all.refetch} />
        )}
      </main>
    </div>
  );
}

export default function skillsApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "skills",
    title: "Skills",
    icon: "Layers",
    path: "skills",
    view: SkillsPage,
  });
}
