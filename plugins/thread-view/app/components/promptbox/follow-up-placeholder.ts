import type { ThreadRuntimeDisplayStatus } from "@bb/domain";

const IDLE = [
  "Ask for a follow-up. @ to mention files, folders, sections, or threads",
  "Ask a follow-up",
];
const PLACEHOLDERS: Record<ThreadRuntimeDisplayStatus, string[]> = {
  provisioning: ["Setting up workspace...", "Setting up..."],
  starting: ["Starting thread...", "Starting..."],
  stopping: [
    "Queue a message to run after the stop",
    "Queue for after the stop",
  ],
  "waiting-for-host": [
    "Queue a message for when the host reconnects",
    "Queue for when the host is back",
  ],
  error: ["Retry by sending a follow-up message", "Send a follow-up"],
  pending: IDLE,
  idle: IDLE,
  active: IDLE,
};

export function getFollowUpPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
): string {
  return PLACEHOLDERS[displayStatus][0]!;
}

export function getCompactFollowUpPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
): string {
  return PLACEHOLDERS[displayStatus][1]!;
}
