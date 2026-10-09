Save a message without sending it.

## What you get

- A **Save draft…** entry in the send menu of a thread's composer.
- A normal queued-message card that you can edit, delete, reorder, or **Send now**.

## How it works

1. Write a message in a thread.
2. Open the send menu and choose **Save draft…**.
3. Use **Send now** on the queued-message card when you are ready.

The draft is queued through the `drafts.create` operation and held by a
`threads.hold` hook until you send it yourself. Drafts carry the message
text; attachments are not saved, and the new-thread screen has no draft entry.
