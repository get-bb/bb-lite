Thread titles from bb cloud, included with your bb account.

## What you get

- A `bb cloud` inference service for thread titles (branch names follow the title).
- On by default once you sign in. Turn it off with `bb ai off`, or disable this plugin.
- While it is ready, bb asks bb cloud for titles before other title services. Signed out, turned off or over the daily limit, it steps aside.
- Today's usage against your daily limit with `bb ai usage`.

## How it works

Sign in with your bb account. When bb cloud writes a title, bb sends the text of the thread's first prompt to getbb through bb account, which forwards it to OpenRouter model providers with zero data retention. getbb stores your daily usage totals and, for 30 days, metadata about each request such as its time, model, token counts, and cost. It never stores prompts or replies. Turn bb cloud off with `bb ai off`; your bb account stays signed in.

## For agents

`bb ai status` and `bb ai usage` report readiness and spend. `bb ai off` turns bb cloud off and `bb ai on` turns it back on; turn it on only when the user asks.

## Requirements

A bb account (`bb account login`).
