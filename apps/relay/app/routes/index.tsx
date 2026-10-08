import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { AddServer } from "../components/add-server";
import { People } from "../components/people";
import { ServerList } from "../components/servers";
import { Section, Shell } from "../components/shell";
import { loadDashboard } from "../data";

const REFRESH_MS = 4_000;

export const Route = createFileRoute("/")({
  loader: async () => {
    const dashboard = await loadDashboard();
    if (dashboard === null) throw redirect({ to: "/login" });
    return dashboard;
  },
  component: DashboardPage,
});

function DashboardPage() {
  const dashboard = Route.useLoaderData();
  const router = useRouter();
  const { servers, baseHost, people } = dashboard;
  const starting = servers.some((server) => server.state === "creating");
  useEffect(() => {
    if (!starting) return;
    const timer = setInterval(() => void router.invalidate(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [starting, router]);
  return (
    <Shell viewer={dashboard.viewer}>
      <Section
        title="Servers"
        description={`The bb servers you own on ${baseHost}.`}
      >
        <ServerList servers={servers} baseHost={baseHost} />
      </Section>
      <Section title="Add a server">
        <AddServer dashboard={dashboard} />
      </Section>
      {people.length === 0 ? null : (
        <Section
          title="People"
          description="Everyone who has signed in. Hosting lets someone link or create servers."
        >
          <People people={people} />
        </Section>
      )}
    </Shell>
  );
}
