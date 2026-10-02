import { extractErrorMessage, toRecord } from "@bb/core-ui";

const NETWORK_TRANSPORT_ERROR_MESSAGE =
  "Could not reach the server. Check that it is running and try again.";

export function getErrorCode(error: unknown): string | null {
  const code = toRecord(error)?.code;
  return typeof code === "string" ? code : null;
}

function isNetworkTransportError(error: unknown): boolean {
  const record = toRecord(error);
  if (
    !record ||
    typeof record.status === "number" ||
    record.name === "AbortError" ||
    typeof record.message !== "string"
  ) {
    return false;
  }
  const message = record.message.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("networkerror")
  );
}

export function getMutationErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  return isNetworkTransportError(error)
    ? NETWORK_TRANSPORT_ERROR_MESSAGE
    : (extractErrorMessage(error) ?? fallbackMessage);
}
