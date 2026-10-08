import { createBbSdk, type BbSdk } from "./core.js";

export interface CreateBrowserBbSdkArgs {
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DOOR_HEADER = "x-bb-door";

export function createBrowserBbSdk(args: CreateBrowserBbSdkArgs = {}): BbSdk {
  const send = args.fetch ?? fetch;
  return createBbSdk({
    baseUrl: args.baseUrl ?? "",
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(DOOR_HEADER, "app");
      return send(input, { ...init, headers });
    },
  });
}

export * from "./core.js";
