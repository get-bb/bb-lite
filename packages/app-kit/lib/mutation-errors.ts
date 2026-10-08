import { extractErrorMessage, toRecord } from "@bb/core-ui";
import { appToast } from "../components/ui/app-toast";
import { asHttpError, getHttpErrorMessage } from "./http-error";
import {
  describeLifecycleError,
  formatLifecycleErrorDescription,
  type LifecycleErrorOperation,
} from "./lifecycle-errors";

interface MutationErrorMessageOptions {
  error: unknown;
  fallbackMessage: string;
  lifecycleOperation?: LifecycleErrorOperation | undefined;
}

export function isAbortLikeError(error: unknown): boolean {
  return toRecord(error)?.name === "AbortError";
}

export function isNetworkTransportError(error: unknown): boolean {
  if (asHttpError(error) !== null || isAbortLikeError(error)) return false;
  const message = toRecord(error)?.message;
  return (
    typeof message === "string" &&
    /failed to fetch|load failed|networkerror/i.test(message)
  );
}

export function getMutationErrorMessage({
  error,
  fallbackMessage,
  lifecycleOperation: operation,
}: MutationErrorMessageOptions): string {
  const lifecycle = describeLifecycleError({ error, operation });
  if (lifecycle) return formatLifecycleErrorDescription(lifecycle);
  const httpError = asHttpError(error);
  if (httpError !== null) {
    return getHttpErrorMessage(httpError) ?? fallbackMessage;
  }
  if (isNetworkTransportError(error)) {
    return "Could not reach the server. Check that it is running and try again.";
  }
  return extractErrorMessage(error) ?? fallbackMessage;
}

export function showMutationErrorToast(
  options: MutationErrorMessageOptions,
): void {
  const { error, fallbackMessage, lifecycleOperation: operation } = options;
  if (isAbortLikeError(error)) return;
  const lifecycle = describeLifecycleError({ error, operation });
  if (lifecycle) {
    appToast.error(lifecycle.title, { description: lifecycle.body });
    return;
  }
  const message = getMutationErrorMessage(options).replace(/\.$/u, "");
  if (message === "Request failed") {
    appToast.error("Request failed", { description: "Please try again" });
    return;
  }
  const title = fallbackMessage.replace(/\s+/g, " ").trim().replace(/\.$/u, "");
  appToast.error(
    title,
    message === title ? undefined : { description: message },
  );
}
