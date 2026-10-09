export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export type VoiceState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; startedAt: number }
  | { status: "transcribing" };

export type VoiceEvent =
  | { type: "start" }
  | { type: "recording"; at: number }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "done" };

export const IDLE: VoiceState = { status: "idle" };

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "start":
      return state.status === "idle" ? { status: "starting" } : state;
    case "recording":
      return state.status === "starting"
        ? { status: "recording", startedAt: event.at }
        : state;
    case "stop":
      return state.status === "recording" ? { status: "transcribing" } : state;
    case "cancel":
      return state.status === "transcribing" ? state : IDLE;
    case "done":
      return IDLE;
  }
}

export function recordingProblem(bytes: number): string | null {
  if (bytes === 0) return "No audio was captured";
  if (bytes > MAX_AUDIO_BYTES) {
    return "Recording is too long to transcribe (the limit is 10 MB)";
  }
  return null;
}

export function spokenInsertion(before: string, text: string): string {
  const spoken = text.trim();
  if (spoken === "") return "";
  return before === "" || /\s$/.test(before) ? spoken : ` ${spoken}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone permission denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found";
    case "NotReadableError":
    case "TrackStartError":
      return "Microphone is unavailable or already in use";
    default:
      return error instanceof Error && error.message.trim() !== ""
        ? error.message
        : "Voice input failed";
  }
}

export function unsupportedReason(environment: {
  hasRecorder: boolean;
  isSecureContext: boolean;
}): string | null {
  if (environment.hasRecorder) return null;
  return environment.isSecureContext
    ? "Voice input is not supported in this browser"
    : "Voice input needs an HTTPS connection to this server";
}

export function pickMimeType(
  isSupported: (mimeType: string) => boolean,
): string | undefined {
  return ["audio/webm", "audio/mp4", "audio/ogg"].find(isSupported);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function level(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}
