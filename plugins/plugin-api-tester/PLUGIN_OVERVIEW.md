A workbench for people who build bb plugins. Use it to confirm that plugin
loading, operations, doors and slots work in your build.

## What you get

- A Plugin API Tester page in the sidebar with its own URL. It calls the
  plugin's `plugin-api-tester.status` operation and shows the answer.
- `bb api-tester status`, the same operation through its CLI door.

## How it works

The plugin declares one operation with a CLI door and fills one slot
(`shell.navPanel`). It adds no agent tools and no settings. It loads in the
`development` profile only.

## Requirements

None. The plugin does not contact an external service and does not need an
account.
