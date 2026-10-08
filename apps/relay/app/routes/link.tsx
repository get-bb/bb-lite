import { Button } from "@bb/shared-ui/button";
import { Label } from "@bb/shared-ui/label";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import type { LinkView } from "../../src/dashboard-types.js";
import { Mark } from "../components/brand";
import { AddressField, Centered, Problem } from "../components/shell";
import { useAction } from "../components/use-action";
import { loadLink, post } from "../data";
import { Message } from "./__root";

export const Route = createFileRoute("/link")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : "",
  }),
  loaderDeps: ({ search }) => ({ code: search.code }),
  loader: async ({ deps }) => {
    const state = await loadLink({ data: deps.code });
    if (state.signedIn) return state;
    const next = `/link?code=${encodeURIComponent(deps.code)}`;
    throw redirect({ to: "/login", search: { next } });
  },
  component: LinkPage,
});

function LinkPage() {
  const state = Route.useLoaderData();
  if ("problem" in state) {
    return <Message title="This code cannot be used" detail={state.problem} />;
  }
  return <Approve view={state.view} />;
}

function Approve({ view }: { view: LinkView }) {
  const [label, setLabel] = useState(view.suggestedLabel);
  const [outcome, setOutcome] = useState<string | null | undefined>();
  const { pending, problem, run } = useAction();
  const answer = (action: "approve" | "deny") =>
    run(action, async () => {
      const body = { code: view.userCode, action, label };
      const { url } = await post<{ url: string | null }>("/link", body);
      setOutcome(url);
    });
  if (outcome === null) {
    return (
      <Message title="Denied" detail="That bb server was not connected." />
    );
  }
  if (outcome !== undefined) {
    return (
      <Centered>
        <Mark className="h-6 w-auto" />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Connected</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your bb server is now at {new URL(outcome).host}.
        </p>
        <div className="mt-6 flex gap-2">
          <Button asChild>
            <a href={outcome}>Open it</a>
          </Button>
          <Button variant="outline" asChild>
            <a href="/">Your servers</a>
          </Button>
        </div>
      </Centered>
    );
  }
  const busy = pending !== null;
  return (
    <Centered>
      <Mark className="h-6 w-auto" />
      <h1 className="mt-6 text-xl font-semibold tracking-tight">
        Connect a bb server
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{view.clientName}</span>{" "}
        wants an address here. Approve only if you just ran{" "}
        <code className="font-mono text-xs">bb connect login</code> and it shows
        this code.
      </p>
      <p className="mt-5 rounded-lg border border-border-hairline bg-surface-recessed py-4 text-center font-mono text-2xl font-medium tracking-[0.25em]">
        {view.userCode}
      </p>
      <form
        className="mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void answer("approve");
        }}
      >
        <Label htmlFor="link-address">Address</Label>
        <div className="mt-2 flex">
          <AddressField
            id="link-address"
            value={label}
            baseHost={view.baseHost}
            disabled={busy}
            onChange={setLabel}
          />
        </div>
        <Problem message={problem} />
        <div className="mt-5 flex gap-2">
          <Button type="submit" disabled={busy} className="flex-1">
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className="flex-1"
            onClick={() => void answer("deny")}
          >
            Deny
          </Button>
        </div>
      </form>
    </Centered>
  );
}
