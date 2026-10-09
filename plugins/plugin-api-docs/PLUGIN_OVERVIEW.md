Browse the bb plugin API that is loaded right now. The Plugin Guide is a page
in the sidebar, and `bb plugin-api` prints the same reference for agents.

## What you get

- A searchable list of every contract the server and app kernels know,
  including the ones other plugins declare, each marked server, app or both,
  and the plugin API version.
- For each operation: its kind, who may call it, its doors (CLI usage, agent
  tool name, HTTP method and path, the app door), who implements it, who hooks
  it, and its input and output shapes.
- For each event, slot and live value: its shape, who listens, who fills the
  slot (on the server and in the app) and who provides the value.
- For each loaded plugin: what it declares, implements, hooks, listens to,
  fills and provides.

## How it works

The page merges `plugins.contracts` (the server kernel) with `describeApp()`
(the app kernel) and reads `plugins.describe` for a plugin's view, so the
reference matches the running bb, shapes included. `bb plugin-api` runs on the
server and cannot see the app kernel: it lists app-only contracts from
`@bb/plugin/app` without who fills them.

## For agents

Run `bb plugin-api <name>` with a contract, a member such as `threads.get`, or
a search word, or `bb plugin-api --plugin <id>` for one plugin. In the composer, type `@` and a member name to attach its
reference to a message.
