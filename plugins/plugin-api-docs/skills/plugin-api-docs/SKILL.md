---
name: plugin-api-docs
description: "Look up the bb plugin API that is loaded right now: contracts, operations with their input and output shapes and doors, events, slots, and which plugin implements or fills each."
---

# Look up the plugin API

`bb plugin-api` prints the plugin API this bb has loaded, read from the running
kernel, so it includes contracts other plugins declare, with their shapes.

- `bb plugin-api` lists every contract with its member count and the API
  version. Contracts marked "app only" (such as `shell`, `composer`,
  `sidePanel`, `threadView`) live in the app.
- `bb plugin-api threads` prints one contract: each operation, event, slot and
  live value in it.
- `bb plugin-api threads.get` prints one member: kind, who may call it, its
  CLI usage (positionals and flags), agent tool name, HTTP method and path,
  who implements and hooks it, and its input and output as JSON Schema.
- `bb plugin-api mention` lists every member whose name contains the word.
- `bb plugin-api --plugin tasks` prints what one plugin declares, implements,
  hooks, listens to, fills and provides on the server.

Add `--json` to get the text as a JSON string.

The CLI runs on the server, so for app-only contracts it shows shapes but not
which plugins fill them; the Plugin Guide page in the app shows both sides.

To write or change a plugin, use the `bb-plugin-authoring` skill from the
plugin-dev plugin (`plugins/plugin-dev/skills/bb-plugin-authoring`) and the
guide in `docs/plugin-api.md`.
