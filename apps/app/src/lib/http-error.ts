import { extractErrorMessage } from "@bb/core-ui";
import { BbHttpError } from "@bb/sdk/browser";

export function asHttpError(error: unknown): BbHttpError | null {
  return error instanceof BbHttpError ? error : null;
}

const HTTP_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = {
  machine_not_shared:
    "That machine is private to its owner. Ask them to share it, or pick another machine.",
};

export function getHttpErrorMessage(error: BbHttpError): string | null {
  const codeMessage =
    error.code === null ? undefined : HTTP_ERROR_CODE_MESSAGES[error.code];
  if (codeMessage !== undefined) return codeMessage;
  return (
    extractErrorMessage(error.body) ??
    extractErrorMessage(error.message.replace(/^HTTP \d{3}:\s*/u, ""))
  );
}
