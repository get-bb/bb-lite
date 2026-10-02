Keep a Claude Code or Codex thread running when one account hits its limit. The Account Pooler puts every account you own behind a local hub and picks the account for each request.

## What you get

- A pool of Claude and Codex accounts, added by signing in through the browser, importing the login already on the server host, or adding an Anthropic API key from the CLI.
- Accounts run one after another in priority order, with ties following the order added. New conversations stay on the current fallback even when an earlier account recovers. Existing conversations keep their own account until it becomes unavailable.
- Limit windows per account and model family in the plugin's settings card, and the same numbers from `bb pool status`.
- A routing switch per provider and a quota switch threshold.

## How it works

The hub serves the Anthropic Messages and OpenAI Responses endpoints under `/api/v1/plugins/account-pool/http`. Routed sessions receive a machine-scoped hub token; the hub forwards each request with the chosen account's credentials and streams the answer back unbuffered. Accounts in error are skipped. The switch threshold defaults to 98 percent. Claude extra usage and Codex credits are fallbacks used only when every account is past the threshold. Secrets stay on the server in 0600 files and OAuth tokens refresh five minutes before expiry.

The pool waits once on the same account for short rate limits, moves to the next account on quota rejections and upstream failures, and answers 429 with Retry-After when nothing is eligible. The current account, session pins and observed quota survive restarts.

The pool uses HTTP/1.1 and honors standard proxy environment variables. Connection failures log error codes without credentials or request contents.

## For agents

`bb pool account add|login-complete|login-poll|list|remove|enable|disable|priority`, `bb pool status`, `bb pool routing <claude|codex> [--off]`, `bb pool config` and `bb pool config set switchThreshold <value>`. Every command takes `--json` and `--help`.
