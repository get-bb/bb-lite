import { createApiClient } from "@bb/server-contract";
import { sessionAwareFetch } from "./sdk";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

export const apiClient = createApiClient(BASE_URL, {
  fetch: sessionAwareFetch,
}).api.v1;

export function toRelativeUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}
