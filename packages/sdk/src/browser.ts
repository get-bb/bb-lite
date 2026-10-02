import { createBbSdk, type BbSdk } from "./core.js";

export interface CreateBrowserBbSdkArgs {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createBrowserBbSdk(args: CreateBrowserBbSdkArgs = {}): BbSdk {
  return createBbSdk({
    baseUrl: args.baseUrl ?? "",
    fetch: args.fetch ?? fetch,
  });
}

export * from "./core.js";
