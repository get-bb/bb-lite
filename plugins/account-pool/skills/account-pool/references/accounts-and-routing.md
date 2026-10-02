Add Claude or Codex credentials and inspect the pool's routes and quota with:

```sh
bb pool account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session <id> --code-stdin
bb pool account add --provider codex --login
bb pool account login-poll --session <id>
bb pool account add --provider <claude|codex> --import [--label <text>] [--priority <n>]
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb pool account list [--json]
bb pool account remove <id>
bb pool account enable <id>
bb pool account disable <id>
bb pool account priority <id> <n>
bb pool status [--json]
bb pool routing <claude|codex> [--off]
bb pool config
bb pool config set switchThreshold <value>
```

Every command accepts `--json` and `--help`. A failing invocation that carries
`--json` also prints `{"ok":false,"error":{"code","message","hint"}}` on stdout.

## Adding accounts

Claude `--login` starts a PKCE session, prints a browser URL and session ID,
then exits. Pipe the code from the final page (`code#state`, the bare code, or
the callback URL) to `account login-complete` with that session ID within ten
minutes. Codex `--login` prints a device verification URL, a one-time code and
a session ID; `account login-poll` waits for the authorization. The browser may
be on a different machine from the bb server.

`--import` copies the login already on the bb server host
(`~/.claude/.credentials.json` with `~/.claude.json`, or `~/.codex/auth.json`).
The pool then refreshes that login on its own, which can invalidate the copy
the local CLI still holds; prefer `--login` for an account the host also uses
directly. `--api-key` (Claude only) adds a metered key; pipe it through
`--api-key-stdin` so it stays out of process arguments and transcripts.

Secrets are stored as 0600 files under the plugin's data directory and are
never printed by any command.

## Routing

With routing on for a provider and at least one enabled account whose secret is
readable, new Claude Code and Codex sessions on every machine are pointed at the
hub with a token minted per machine. `bb pool routing <provider> --off` stops
contributing the route; running sessions keep the route they started with.

Accounts run per provider in priority order (lower first, ties in the order
added). A new conversation uses the provider's current account until it reaches
the switch threshold (`switchThreshold`, default 0.98 of any limit window) or
fails; the pool then advances to the next eligible account and stays there even
when an earlier account recovers. Existing conversations stay on their account
while it remains eligible; pins expire after 30 idle minutes. A model-family
weekly limit detours only requests for that family. An account with extra usage
or credits allowed stays usable as a last resort once every account is past the
threshold.

Short rate limits (Retry-After up to 20 seconds) are waited out once on the
same account. Upstream 401, 403, 408, 5xx and 529 answers move the request to
the next account; a 401 or 403 first forces one token refresh and retries the
same account. When no account is eligible the hub answers 429 with Retry-After
set to the earliest reset.

## Account states

`ready`, `held` (temporarily rate limited), `exhausted` (a limit window is past
the threshold or rejected; `blockedUntil` is the reset), `disabled`, and
`error`. An account enters `error` when its refresh token is rejected (HTTP 400
or 401 from the token endpoint) or its API key is rejected; sign in again, or
run `bb pool account enable <id>` to clear the error and retry.

OAuth tokens refresh five minutes before expiry. Usage is polled when an
account is added or enabled, every five minutes while idle, and before the hub
refuses a request for lack of quota.
