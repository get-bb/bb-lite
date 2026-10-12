---
name: mcp
description: Connect ChatGPT, Claude or another MCP client to this bb, and list or disconnect the apps that have access.
---

# bb MCP server

The MCP server plugin lets an MCP client control this bb. It is off by default. Turn it on in Settings → Plugins or with `bb plugin enable mcp`.

## Addresses

`bb mcp status [--json]` prints both addresses as `{ remoteUrl, localUrl, remoteProblem }`.

- **Remote**: `https://<your bb connect address>/mcp`. This needs bb connect signed in and on (`bb connect login`). Add it as a custom connector in ChatGPT or Claude. The app sends you to a bb account page where you approve access for this bb.
- **Local**: `http://127.0.0.1:<port>/api/v1/plugins/mcp/http/mcp`. Apps on the bb server's own machine can use it without signing in. It has the same trust as the `bb` CLI on that machine. Requests from web pages, from other computers on the network, and from people signed in to the bb app are refused.

## What approving an app grants

Access is all or nothing, and it is the owner's access. This bb can have several users, but an approved app does not act as the user who approved it: its scripts run the `bb` CLI on the server's machine, and that CLI acts as the owner. The app can see every user's threads, change settings and users, and start and message agents and open terminals, which run commands and change files on the machines this bb controls. Approve only apps you trust, and disconnect the ones you no longer use.

## Connected apps

Only the owner can run these.

- `bb mcp clients [--json]` lists the remote apps with access to this bb: `[{ id, clientId, clientName, scope, createdAt, lastUsedAt }]`.
- `bb mcp revoke <grant-id> [--json]` disconnects one. The app loses access within about a minute.

Both ask the bb account service, so they need bb connect signed in.

## Tools the client sees

- `search` finds `bb` commands for a task, built-in ones and those of enabled plugins, and says which of them `read` accepts.
- `read` runs a JavaScript snippet that can call only commands that inspect bb. It is marked read-only so the app can run it without asking you each time; it is not a separate permission. The list is fixed: built-in commands that change nothing, and plugin commands that are operations declared as reads. Aliases and every other plugin command need `run`.
- `run` runs a JavaScript snippet that can call any `bb` command.

Snippets call `bb.cli([...argv])` or `bb.json([...argv])` and run in a sandbox on the bb server with no network or file access. A snippet is stopped after 25 seconds or 3 seconds of computation, and runs at most 4 `bb` commands at a time.

Three commands cannot run over MCP because they never exit: `bb server`, `bb runner run`, and `bb dev watch`.

## Protocol

The endpoint speaks MCP 2026-07-28 and also answers 2025-era clients. It is stateless: there are no sessions.
