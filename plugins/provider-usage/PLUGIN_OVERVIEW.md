# Provider usage

Shows each provider's usage limits and reset times: a chart button in the sidebar footer opens a
card, and the plugin's settings page has a **Usage** section with the same view. Pick **Shared
accounts** or a machine to read that machine's local usage; the choice is remembered. Each account
shows its plan and, per usage window, a bar, the percent (or dollars) used and when it resets.
Usage at 80% turns the footer button amber, at 95% red.

`bb provider-usage show [--host-id <id>] [--refresh] [--json]` prints the same thing.

Sources: a provider plugin adds a `sessions.usage` entry, `{ providerId, read({ hostId }) }`.
`read` returns `null` (nothing to report), one usage value, or `{ accounts: [{ accountKey, label,
usage }] }` for pooled accounts. A usage value is `{ status: "ok", accountEmail, planLabel, plan,
windows }` or `not_installed`, `unauthenticated`, `expired`, `error` (`message`); the schemas are in
`contract.ts` (`usageReadingSchema`). `hostId` is null for shared accounts. Windows with a `kind`
(`five-hour`, `daily`, `weekly`) and a known `plan.id` get consistent labels. Accounts with the same
`accountKey` are shown once; unknown keys are never merged.

Readings are kept for two minutes, marked stale when a thread finishes, and re-read on **Reload**.
A failed refresh keeps the last reading with a notice; unavailable usage is never shown as zero.
