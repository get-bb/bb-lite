import { Pill } from "@bb/shared-ui/pill";
import { Switch } from "@bb/shared-ui/switch";
import type { PersonView } from "../../src/dashboard-types.js";
import { post } from "../data";
import { Avatar, Panel, Problem } from "./shell";
import { useAction } from "./use-action";

function Person({ person }: { person: PersonView }) {
  const { pending, problem, run } = useAction();
  const toggle = (canHost: boolean) =>
    run("hosting", () => post(`/people/${person.id}`, { canHost }));
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <Avatar name={person.name} url={person.avatarUrl} className="size-7" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{person.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            @{person.login}
          </p>
        </div>
        {person.self ? (
          <Pill variant="outline" size="sm">
            You
          </Pill>
        ) : (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Can host
            <Switch
              checked={person.canHost}
              disabled={pending !== null}
              aria-label={`Let ${person.name} host servers`}
              onCheckedChange={(checked) => void toggle(checked)}
            />
          </label>
        )}
      </div>
      <Problem message={problem} />
    </li>
  );
}

export function People({ people }: { people: PersonView[] }) {
  return (
    <Panel>
      <ul className="divide-y divide-border-hairline">
        {people.map((person) => (
          <Person key={person.id} person={person} />
        ))}
      </ul>
    </Panel>
  );
}
