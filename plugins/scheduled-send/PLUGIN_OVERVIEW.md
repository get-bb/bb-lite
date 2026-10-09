Write a follow-up message now and let bb send it when you choose. The message keeps its text, model, reasoning level, service tier and permission mode.

## What you get

- A **Send later…** entry in the composer's send menu.
- Presets for 5 minutes, 10 minutes, 30 minutes, 1 hour, 2 hours, this evening, and tomorrow morning.
- A custom date and time picker with a preview of the local send time and time zone.
- The scheduled message is an ordinary timed queued message, shown in the thread's queue where you can send it now or delete it.

## How it works

1. Type a message in a thread.
2. Open the send menu and choose **Send later…**.
3. Pick a preset or a custom time up to one year ahead.
4. Choose **Schedule send**.

The plugin sends the draft text with `threads.send` and a `sendAt` time, then clears the composer. The entry is offered only in a thread's composer, when the draft has text, no attachments, and a send is allowed.

The plugin adds no agent tools or CLI commands.
