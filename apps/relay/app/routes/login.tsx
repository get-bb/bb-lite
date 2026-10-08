import { Button } from "@bb/shared-ui/button";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { GithubMark, Mark } from "../components/brand";
import { Centered, Problem } from "../components/shell";
import { loadLogin } from "../data";

const PROBLEMS: Record<string, string> = {
  expired: "That sign-in expired. Try again.",
  github: "GitHub did not confirm the sign-in. Try again.",
};

interface LoginSearch {
  next?: string;
  error?: string;
}

function text(value: unknown) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    next: text(search.next),
    error: text(search.error),
  }),
  loaderDeps: ({ search }) => ({ next: search.next }),
  loader: async ({ deps }) => {
    const { viewer, baseHost } = await loadLogin();
    if (viewer === null) return { baseHost };
    const { next } = deps;
    if (next?.startsWith("/") && !next.startsWith("//")) {
      throw redirect({ href: next });
    }
    if (next === undefined) throw redirect({ to: "/" });
    const query = `?next=${encodeURIComponent(next)}`;
    throw redirect({ href: `/auth/github${query}`, reloadDocument: true });
  },
  component: LoginPage,
});

function LoginPage() {
  const { next, error } = Route.useSearch();
  const { baseHost } = Route.useLoaderData();
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  return (
    <Centered>
      <Mark className="h-7 w-auto" />
      <h1 className="mt-7 text-2xl font-semibold tracking-tight">
        Sign in to bb-next
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        One account for every bb server you reach through {baseHost}.
      </p>
      <Button asChild className="mt-7 h-10 w-full">
        <a href={`/auth/github${query}`}>
          <GithubMark className="size-4" />
          Continue with GitHub
        </a>
      </Button>
      <Problem
        message={error === undefined ? null : (PROBLEMS[error] ?? null)}
      />
    </Centered>
  );
}
