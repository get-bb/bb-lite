import { sdk } from "@/lib/sdk";

export function createPluginsClient(_fetchImpl: typeof fetch) {
  return sdk.plugins;
}
