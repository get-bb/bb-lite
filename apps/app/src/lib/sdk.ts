import { createBrowserBbSdk } from "@bb/sdk/browser";

type FetchInput = Parameters<typeof fetch>[0];

let unauthenticatedHandler: (() => void) | null = null;

export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  unauthenticatedHandler = handler;
}

function requiresSession(input: FetchInput): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const { pathname } = new URL(url, "http://localhost");
  return (
    pathname.startsWith("/api/v1/") && !pathname.startsWith("/api/v1/auth/")
  );
}

export async function sessionAwareFetch(
  input: FetchInput,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 && requiresSession(input)) {
    unauthenticatedHandler?.();
  }
  return response;
}

export const sdk = createBrowserBbSdk({
  baseUrl:
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  fetch: sessionAwareFetch,
});

export { BbHttpError } from "@bb/sdk/browser";
