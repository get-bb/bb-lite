import { Button } from "@bb/shared-ui/button";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import type { ConsentView } from "../../src/dashboard-types.js";
import { Mark } from "../components/brand";
import { Centered, Problem } from "../components/shell";
import { loadConsent, post } from "../data";

export const Route = createFileRoute("/oauth/authorize")({
  head: () => ({
    meta: [
      { title: "Connect an app to your bb" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  loader: async () => {
    const browserQuery =
      typeof window === "undefined" ? null : window.location.search;
    const state = await loadConsent({ data: browserQuery });
    if (state.signedIn) return state;
    const next = `/oauth/authorize${state.query}`;
    throw redirect({ to: "/login", search: { next } });
  },
  component: AuthorizePage,
});

function AuthorizePage() {
  const state = Route.useLoaderData();
  if ("problem" in state) {
    return (
      <Centered>
        <Mark className="h-6 w-auto" />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">
          This app can&rsquo;t be connected
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The app sent a sign-in request that bb can&rsquo;t accept. This is a
          problem with the app, not with your account. Nothing was shared, and
          you can close this page.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Reason: <span className="font-mono">{state.problem}</span>
        </p>
      </Centered>
    );
  }
  return <Consent query={state.query} consent={state.consent} />;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-3 py-2">
      <dt className="w-24 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm break-words">{children}</dd>
    </div>
  );
}

function Consent({ query, consent }: { query: string; consent: ConsentView }) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (approved: boolean) => {
    setBusy(approved ? "approve" : "deny");
    setProblem(null);
    try {
      const body = { query, approved };
      const { url } = await post<{ url: string }>("/oauth/decision", body);
      window.location.assign(url);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(null);
    }
  };
  const { clientName } = consent;
  return (
    <Centered>
      <Mark className="h-6 w-auto" />
      <h1 className="mt-6 text-xl font-semibold tracking-tight">
        Let {clientName} use your bb?
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Only approve this if you just asked {clientName} to connect to your bb.
      </p>
      <dl className="mt-5 divide-y divide-border-hairline rounded-lg border border-border-hairline bg-surface-recessed">
        <Fact label="App">
          <span className="font-medium">{clientName}</span>
          <span className="block text-xs text-muted-foreground">
            from <code className="font-mono">{consent.clientIdHost}</code>
          </span>
        </Fact>
        <Fact label="Your bb">
          <span className="font-medium">{consent.serverLabel}</span>
          <span className="block text-xs text-muted-foreground">
            <code className="font-mono">{consent.address}</code>
          </span>
        </Fact>
        <Fact label="Afterwards">
          You&rsquo;ll be sent to{" "}
          <code className="font-mono">{consent.redirectHost}</code>
        </Fact>
      </dl>
      {consent.loopbackRedirect ? (
        <p className="mt-3 rounded-lg border border-border-hairline px-3 py-2 text-xs text-muted-foreground">
          An app on this computer will receive this sign-in. Only continue if
          you just started this from an app on this device.
        </p>
      ) : null}
      <h2 className="mt-5 text-sm font-semibold">What approving allows</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {clientName} can see everything in this bb: threads, projects,
        environments, diffs, and settings. It can also start and steer agents,
        which run commands and change files on the machines this bb controls.
        Only approve apps you trust.
      </p>
      <Problem message={problem} />
      <div className="mt-5 flex gap-2">
        <Button
          disabled={busy !== null}
          className="flex-1"
          onClick={() => void decide(true)}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button
          variant="outline"
          disabled={busy !== null}
          className="flex-1"
          onClick={() => void decide(false)}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        You can disconnect this app at any time from your servers page here.
      </p>
    </Centered>
  );
}
