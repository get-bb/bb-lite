import { useAtom } from "jotai";
import { rewriteLocalhostLinkHref } from "@bb/client-core";
import { createBooleanPreferenceAtom } from "./browser-storage";

export { rewriteLocalhostLinkHref };

const EXAMPLE_HREF = "http://localhost:3000/";
const rewriteLocalhostLinksPreferenceAtom = createBooleanPreferenceAtom(
  "bb.rewriteLocalhostLinks",
  true,
);

export function useRewriteLocalhostLinksPreference() {
  return useAtom(rewriteLocalhostLinksPreferenceAtom);
}

export function localhostLinkRewriteDescription(
  currentHostname: string | undefined,
): string | null {
  const rewrittenHref = rewriteLocalhostLinkHref({
    currentHostname,
    enabled: true,
    href: EXAMPLE_HREF,
  });
  return rewrittenHref === EXAMPLE_HREF
    ? null
    : `When enabled, localhost URLs are rewritten to use the same host or IP address you use to open BB. For example: ${EXAMPLE_HREF} → ${rewrittenHref}`;
}
