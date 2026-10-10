import { CallError } from "@bb/plugin/app";
import { extractErrorMessage } from "@bb/core-ui";

export function asHttpError(error: unknown): CallError | null {
  return error instanceof CallError ? error : null;
}

const HTTP_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = {
  machine_not_shared:
    "That machine is private to its owner. Ask them to share it, or pick another machine.",
};

export function getHttpErrorMessage(error: CallError): string | null {
  const codeMessage =
    error.code === null ? undefined : HTTP_ERROR_CODE_MESSAGES[error.code];
  if (codeMessage !== undefined) return codeMessage;
  return (
    extractErrorMessage(error.body) ??
    extractErrorMessage(error.message.replace(/^HTTP \d{3}:\s*/u, ""))
  );
}
