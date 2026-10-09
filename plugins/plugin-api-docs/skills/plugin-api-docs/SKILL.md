---
name: plugin-api-docs
description: "Look up the bb plugin API that is loaded right now: contracts, operations with their input and output shapes and doors, events, slots, and which plugin implements or fills each."
---

# Look up the plugin API

`bb plugin-api` prints the plugin API this bb has loaded, generated from the
running kernel, so it includes contracts other plugins declare.

- `bb plugin-api` lists every contract with its member count and the API
  version.
- `bb plugin-api threads` prints one contract: each operation, event, slot and
  live value in it.
- `bb plugin-api threads.get` prints one member: kind, who may call it, its
  CLI usage, agent tool name, HTTP method and path, who implements and hooks
  it, and its input and output as JSON Schema.
- `bb plugin-api mention` lists every member whose name contains the word.

Add `--json` to get the text as a JSON string.

Contracts declared by core (`@bb/plugin`, `@bb/plugin/app`, `@bb/runner`)
show their shapes and door details. Contracts declared by other plugins show
their doors, owner, hooks, listeners and contributors; read that plugin's
`contract.ts` for the shapes.

To write or change a plugin, use the `bb-plugin-authoring` skill from the
plugin-dev plugin (`plugins/plugin-dev/skills/bb-plugin-authoring`) and the
guide in `docs/plugin-api.md`.
