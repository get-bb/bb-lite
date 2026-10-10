import type { ReactNode } from "react";
import type { SystemExecutionOptionsModelLoadError } from "@bb/server-contract";
import { useUrlAnchorClickHandler } from "@bb/app-kit/lib/url-open-routing";

interface FormatModelLoadErrorTextArgs {
  error: SystemExecutionOptionsModelLoadError;
  providerLabel: string;
}

function modelLoadErrorReason(
  error: SystemExecutionOptionsModelLoadError,
): string | null {
  switch (error.code) {
    case "provider_unavailable":
      return "Provider plugin failed to load";
    case "missing_executable":
      return "CLI not found";
    case "auth_required":
      return "Not signed in";
    case "timeout":
      return "Timed out";
    case "failed":
      return error.detail;
  }
}

export function formatModelLoadErrorText({
  error,
  providerLabel,
}: FormatModelLoadErrorTextArgs): string {
  const summary = `Could not load models for ${providerLabel}.`;
  const reason = modelLoadErrorReason(error);
  return reason === null ? summary : `${summary} ${reason}.`;
}

export function formatModelLoadErrorTitle({
  error,
  providerLabel,
}: FormatModelLoadErrorTextArgs): string {
  const summary = `Could not load models for ${providerLabel}.`;
  const detail = error.detail ?? modelLoadErrorReason(error);
  return detail === null ? summary : `${summary}\n${detail}`;
}

export function ModelLoadErrorMessage({
  error,
  providerLabel,
  installUrl,
}: FormatModelLoadErrorTextArgs & {
  installUrl: string | undefined;
}): ReactNode {
  const helpUrl = error.code === "missing_executable" ? installUrl : undefined;
  const handleHelpLinkClick = useUrlAnchorClickHandler(helpUrl);
  const reason = modelLoadErrorReason(error);
  return (
    <>
      <span className="block">Could not load models for {providerLabel}.</span>
      {reason === null ? null : (
        <span className="mt-1 line-clamp-3 block break-words opacity-80 [overflow-wrap:anywhere]">
          {helpUrl === undefined ? (
            reason
          ) : (
            <a
              href={helpUrl}
              target="_blank"
              rel="noreferrer"
              onClick={handleHelpLinkClick}
              className="underline underline-offset-2 hover:text-foreground"
            >
              {reason}
            </a>
          )}
        </span>
      )}
    </>
  );
}
