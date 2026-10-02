import { extractErrorMessage } from "@bb/core-ui";
import { BbHttpError } from "@bb/sdk/browser";

export function asHttpError(error: unknown): BbHttpError | null {
  return error instanceof BbHttpError ? error : null;
}

export function getHttpErrorMessage(error: BbHttpError): string | null {
  return (
    extractErrorMessage(error.body) ??
    extractErrorMessage(error.message.replace(/^HTTP \d{3}:\s*/u, ""))
  );
}
