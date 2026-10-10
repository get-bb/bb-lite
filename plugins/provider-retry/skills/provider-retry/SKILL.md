---
name: provider-retry
description: "Diagnose automatic retries of BB turns after provider overloads and subscription-window limits."
---

# Provider retry

The plugin is enabled on fresh installations. When a turn fails on a provider
overload, or on a structured subscription-window limit with a reset time, it
queues the original input again as a timed queued message: a short doubling
delay for overloads, just past the reset for subscription limits.

A pending retry is an ordinary durable queued message and survives restart.
Inspect it with `bb provider-retry status [thread-id]`, send it at once with
`bb provider-retry retry <thread-id>`, or drop it with
`bb provider-retry cancel <thread-id>`. Inspect the failed turn before
retrying by hand, and avoid duplicating an existing queued retry.
