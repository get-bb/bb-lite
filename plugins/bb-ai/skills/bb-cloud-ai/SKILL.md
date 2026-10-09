---
name: bb-cloud-ai
description: "Check, turn off, or troubleshoot bb cloud, the hosted service that writes thread titles for signed-in bb accounts."
---

# bb cloud AI

bb cloud is the `bb` AI service from the `bb-ai` plugin. It writes thread
titles (branch names follow the title) for a signed-in bb account, within a
daily spend limit per account.

bb cloud is on by default for a signed-in account. A user who turned it off
stays off across restarts and upgrades. While off, signed out, or over the
daily limit, it is not ready: bb does not offer it for titles, other title
services take over, and nothing is sent to getbb.

- `bb ai off [--json]` turns bb cloud off and keeps the bb account signed in;
  `bb ai on [--json]` turns it back on. Only turn it on when the user asks: it
  sends prompt text off the machine. Disabling the `bb-ai` plugin in
  Settings → Plugins also stops it.
- `bb ai status [--json]` shows the account, whether bb cloud is on and ready,
  and today's usage.
- `bb ai usage [--json]` shows today's spend against the limit and when it
  resets (00:00 UTC).
- Sign in with `bb account login`. Signed out, bb cloud is not ready.
- When an account's daily limit is used up, bb cloud reports not ready until
  the reset and titles come from other services or the prompt text.

While bb cloud is on, bb sends the text of a thread's first prompt to getbb,
which forwards it to OpenRouter model providers with zero data retention. bb
stores daily usage totals and, for 30 days, metadata about each request such
as its time, model, token counts, and cost; it never stores prompts or
replies.
