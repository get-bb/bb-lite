import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Mark } from "../components/brand";
import { Centered } from "../components/shell";
import appCss from "../styles.css?url";

const FOLLOW_SYSTEM_THEME = `(function () {
  var dark = matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    document.documentElement.classList.toggle("dark", dark.matches);
  }
  apply();
  dark.addEventListener("change", apply);
})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { name: "referrer", content: "same-origin" },
      { title: "bb-next" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon-32x32.png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  shellComponent: Document,
  component: Outlet,
  notFoundComponent: () => (
    <Message title="Not found" detail="There is nothing at this address." />
  ),
  errorComponent: () => (
    <Message
      title="Something went wrong"
      detail="Reload the page to try again."
    />
  ),
});

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: FOLLOW_SYSTEM_THEME }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export function Message({ title, detail }: { title: string; detail: string }) {
  return (
    <Centered>
      <Mark className="h-6 w-auto" />
      <h1 className="mt-6 text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      <a
        href="/"
        className="mt-6 inline-block text-sm underline underline-offset-4"
      >
        Your servers
      </a>
    </Centered>
  );
}
