import { useEffect, useReducer, useRef, useState } from "react";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { Button } from "@bb/shared-ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  app,
  callOp,
  composer,
  Icon,
  server,
  sessions,
  useOp,
  type ComposerFooterControlProps,
  type ComposerHandle,
  type PluginAppApi,
} from "@bb/plugin/app";
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
} from "./voice";

interface Capture {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  cancelled: boolean;
  audio: AudioContext | null;
  analyser: AnalyserNode | null;
}

function fail(message: string) {
  appToast.error("Voice input failed", { description: message });
}

function release(capture: Capture) {
  for (const track of capture.stream.getTracks()) track.stop();
  void capture.audio?.close().catch(() => undefined);
}

function meter(stream: MediaStream) {
  try {
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 256;
    audio.createMediaStreamSource(stream).connect(analyser);
    return { audio, analyser };
  } catch {
    return { audio: null, analyser: null };
  }
}

function useVoiceInput(handle: ComposerHandle) {
  const [state, dispatch] = useReducer(voiceReducer, IDLE);
  const capture = useRef<Capture | null>(null);
  const latest = useRef(handle);
  const aborter = useRef<AbortController | null>(null);
  latest.current = handle;

  useEffect(
    () => () => {
      aborter.current?.abort();
      const current = capture.current;
      if (current === null) return;
      current.cancelled = true;
      if (current.recorder.state !== "inactive") current.recorder.stop();
      release(current);
    },
    [],
  );

  async function transcribe(audio: Blob) {
    const controller = new AbortController();
    aborter.current = controller;
    try {
      const data = toBase64(new Uint8Array(await audio.arrayBuffer()));
      const { text } = await callOp(
        sessions.transcribe,
        { data, mimeType: audio.type },
        { signal: controller.signal },
      );
      const insertion = spokenInsertion(latest.current.text, text);
      if (insertion === "") fail("No speech was recognized");
      else latest.current.insert(insertion);
    } catch (error: unknown) {
      if (!controller.signal.aborted) fail(microphoneError(error));
    } finally {
      if (!controller.signal.aborted) dispatch({ type: "done" });
    }
  }

  async function start() {
    const unsupported = unsupportedReason({
      hasRecorder:
        typeof MediaRecorder !== "undefined" &&
        navigator.mediaDevices?.getUserMedia !== undefined,
      isSecureContext: window.isSecureContext,
    });
    if (unsupported !== null) return fail(unsupported);
    dispatch({ type: "start" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error: unknown) {
      dispatch({ type: "cancel" });
      return fail(microphoneError(error));
    }
    const mimeType = pickMimeType((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    } catch (error: unknown) {
      for (const track of stream.getTracks()) track.stop();
      dispatch({ type: "cancel" });
      return fail(microphoneError(error));
    }
    const current: Capture = {
      stream,
      recorder,
      chunks: [],
      bytes: 0,
      cancelled: false,
      ...meter(stream),
    };
    capture.current = current;
    recorder.ondataavailable = (event) => {
      current.chunks.push(event.data);
      current.bytes += event.data.size;
      if (current.bytes > MAX_AUDIO_BYTES && recorder.state !== "inactive") {
        recorder.stop();
        dispatch({ type: "stop" });
      }
    };
    recorder.onstop = () => {
      release(current);
      if (capture.current === current) capture.current = null;
      if (current.cancelled) return;
      const problem = recordingProblem(current.bytes);
      if (problem !== null) {
        dispatch({ type: "done" });
        return fail(problem);
      }
      const type = recorder.mimeType || mimeType || "audio/webm";
      void transcribe(new Blob(current.chunks, { type }));
    };
    recorder.start(1000);
    dispatch({ type: "recording", at: Date.now() });
  }

  function stop() {
    const current = capture.current;
    if (current === null || current.recorder.state === "inactive") return;
    dispatch({ type: "stop" });
    current.recorder.stop();
  }

  function cancel() {
    const current = capture.current;
    if (current !== null) {
      current.cancelled = true;
      if (current.recorder.state !== "inactive") current.recorder.stop();
    }
    dispatch({ type: "cancel" });
  }

  return { state, start, stop, cancel, capture };
}

function RecordingStatus({
  startedAt,
  analyser,
}: {
  startedAt: number;
  analyser: AnalyserNode | null;
}) {
  const [now, setNow] = useState(() => ({ at: Date.now(), level: 0 }));
  useEffect(() => {
    const samples = new Uint8Array(analyser?.fftSize ?? 0);
    const timer = window.setInterval(() => {
      analyser?.getByteTimeDomainData(samples);
      setNow({ at: Date.now(), level: level(samples) });
    }, 100);
    return () => window.clearInterval(timer);
  }, [analyser]);
  return (
    <span
      data-voice-recording=""
      className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
    >
      <span className="relative h-3 w-1 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-x-0 bottom-0 rounded-full bg-destructive transition-[height] duration-100"
          style={{ height: `${Math.round(now.level * 100)}%` }}
        />
      </span>
      {formatElapsed(now.at - startedAt)}
    </span>
  );
}

function VoiceButton({ handle }: { handle: ComposerHandle }) {
  const { state, start, stop, cancel, capture } = useVoiceInput(handle);
  const recording = state.status === "recording";

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const label = recording
    ? "Stop recording and transcribe"
    : state.status === "transcribing"
      ? "Transcribing"
      : "Voice input";
  return (
    <span className="flex items-center gap-1">
      {state.status === "recording" ? (
        <RecordingStatus
          startedAt={state.startedAt}
          analyser={capture.current?.analyser ?? null}
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={label}
            aria-pressed={recording}
            disabled={
              state.status === "starting" || state.status === "transcribing"
            }
            className={recording ? "size-7 text-destructive" : "size-7"}
            onClick={() => (recording ? stop() : void start())}
          >
            <Icon
              name={state.status === "transcribing" ? "Spinner" : "Mic"}
              className={
                state.status === "transcribing"
                  ? "size-4 animate-spin"
                  : "size-4"
              }
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {recording ? `${label} (Esc to cancel)` : label}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

function VoiceControl({ context }: ComposerFooterControlProps) {
  const config = useOp(server.config, {});
  if (context.composer === null) return null;
  if (config.data?.voiceTranscriptionEnabled !== true) return null;
  return <VoiceButton handle={context.composer} />;
}

function Mic({ className }: { className?: string }) {
  return <HugeiconsIcon icon={Mic01Icon} className={className} />;
}

export default function voiceInputApp(bb: PluginAppApi): void {
  bb.add(app.icon, { name: "Mic", view: Mic });
  bb.add(composer.footerControl, {
    id: "voice-input",
    row: "actions",
    side: "end",
    order: 0,
    isAvailable: (context) => context.composer !== null,
    view: VoiceControl,
  });
}
