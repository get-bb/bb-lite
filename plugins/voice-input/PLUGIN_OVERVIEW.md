Dictate a message instead of typing it.

## What you get

- A microphone button next to the send button in every composer, shown when
  the server has a transcriber (for example bb cloud from the `bb-ai` plugin).
- Press it to start recording and again to stop; the recording shows the
  elapsed time and a level meter. Escape cancels without transcribing.
- The transcript is inserted at the cursor; mentions already in the draft stay.

## How it works

The app records with `MediaRecorder` and sends the audio to the
`sessions.transcribe` operation (`POST /sessions/transcriptions`), which uses
the first available `sessions.transcription` entry. The button appears only
when `server.config` reports `voiceTranscriptionEnabled`. Recordings over
10 MB, a denied microphone permission, a missing microphone and failed
transcriptions are reported with a toast.

Another plugin can replace this one, or contribute a different transcriber to
`sessions.transcription`.
