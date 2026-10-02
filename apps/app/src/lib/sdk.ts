import { createBrowserBbSdk } from "@bb/sdk/browser";

export const sdk = createBrowserBbSdk({
  baseUrl:
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  fetch: (input, init) => fetch(input, init),
});

export { BbHttpError } from "@bb/sdk/browser";
