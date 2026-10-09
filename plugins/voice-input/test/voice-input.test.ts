import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  IDLE,
  level,
  MAX_AUDIO_BYTES,
  microphoneError,
  pickMimeType,
  recordingProblem,
  spokenInsertion,
  toBase64,
  unsupportedReason,
  voiceReducer,
  type VoiceEvent,
  type VoiceState,
} from "../voice";

function run(events: VoiceEvent[], from: VoiceState = IDLE): VoiceState {
  return events.reduce(voiceReducer, from);
}

describe("voice input", () => {
  it("records, stops into transcribing and returns to idle", () => {
    expect(run([{ type: "start" }])).toEqual({ status: "starting" });
    expect(run([{ type: "start" }, { type: "recording", at: 5 }])).toEqual({
      status: "recording",
      startedAt: 5,
    });
    const transcribing = run([
      { type: "start" },
      { type: "recording", at: 5 },
      { type: "stop" },
    ]);
    expect(transcribing).toEqual({ status: "transcribing" });
    expect(voiceReducer(transcribing, { type: "start" })).toBe(transcribing);
    expect(voiceReducer(transcribing, { type: "cancel" })).toBe(transcribing);
    expect(voiceReducer(transcribing, { type: "done" })).toEqual(IDLE);
  });

  it("cancels a recording without transcribing", () => {
    expect(
      run([
        { type: "start" },
        { type: "recording", at: 1 },
        { type: "cancel" },
      ]),
    ).toEqual(IDLE);
    expect(run([{ type: "stop" }])).toEqual(IDLE);
    expect(run([{ type: "recording", at: 1 }])).toEqual(IDLE);
  });

  it("rejects empty and too long recordings", () => {
    expect(recordingProblem(0)).toBe("No audio was captured");
    expect(recordingProblem(MAX_AUDIO_BYTES)).toBeNull();
    expect(recordingProblem(MAX_AUDIO_BYTES + 1)).toMatch(/too long/);
  });

  it("inserts the transcript with one separating space", () => {
    expect(spokenInsertion("", " hello world ")).toBe("hello world");
    expect(spokenInsertion("ask @repo", "about this")).toBe(" about this");
    expect(spokenInsertion("line\n", "next")).toBe("next");
    expect(spokenInsertion("text ", "   ")).toBe("");
  });

  it("explains microphone failures", () => {
    const named = (name: string) =>
      Object.assign(new Error("raw"), { name }) as Error;
    expect(microphoneError(named("NotAllowedError"))).toBe(
      "Microphone permission denied",
    );
    expect(microphoneError(named("NotFoundError"))).toBe(
      "No microphone was found",
    );
    expect(microphoneError(new Error("transcriber down"))).toBe(
      "transcriber down",
    );
    expect(microphoneError("?")).toBe("Voice input failed");
    expect(
      unsupportedReason({ hasRecorder: false, isSecureContext: false }),
    ).toMatch(/HTTPS/);
    expect(
      unsupportedReason({ hasRecorder: true, isSecureContext: false }),
    ).toBeNull();
  });

  it("formats, encodes and measures", () => {
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(-1)).toBe("0:00");
    expect(pickMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeUndefined();
    const bytes = new Uint8Array(70_000).map((_, index) => index % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(level(new Uint8Array(8).fill(128))).toBe(0);
    expect(level(new Uint8Array(8).fill(255))).toBe(1);
  });
});
