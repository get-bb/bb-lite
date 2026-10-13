import { Button } from "@bb/shared-ui/button";
import type { AppView } from "../../src/dashboard-types.js";
import { post } from "../data";
import { Panel, Problem } from "./shell";
import { useAction } from "./use-action";

const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function usageOf(app: AppView): string {
  const connected = `Connected ${DAY.format(new Date(app.createdAt))}`;
  if (app.lastUsedAt === null) return `${connected} · Never used`;
  return `${connected} · Last used ${DAY.format(new Date(app.lastUsedAt))}`;
}

function App({ app }: { app: AppView }) {
  const { pending, problem, run } = useAction();
  const revoke = () => run("revoke", () => post(`/apps/${app.id}/revoke`));
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {app.clientName}
            <span className="font-normal text-muted-foreground">
              {" · "}
              <span className="font-mono text-xs">{app.address}</span>
            </span>
          </p>
          <p
            className="truncate text-xs text-muted-foreground"
            suppressHydrationWarning
          >
            {usageOf(app)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => void revoke()}
        >
          {pending === null ? "Revoke" : "Revoking…"}
        </Button>
      </div>
      <Problem message={problem} />
    </li>
  );
}

export function ConnectedApps({ apps }: { apps: AppView[] }) {
  return (
    <Panel>
      <ul className="divide-y divide-border-hairline">
        {apps.map((app) => (
          <App key={app.id} app={app} />
        ))}
      </ul>
    </Panel>
  );
}
