Browse the bb plugin API that is loaded right now. The Plugin Guide is a page
in the sidebar, and `bb plugin-api` prints the same reference for agents.

## What you get

- A searchable list of every contract the kernel knows, including the ones
  other plugins declare, and the plugin API version.
- For each operation: its kind, who may call it, its doors (CLI usage, agent
  tool name, HTTP method and path, the app door), who implements it, who hooks
  it, and its input and output shapes.
- For each event, slot and live value: its shape, who listens, who fills the
  slot (on the server and in the app) and who provides the value.

## How it works

Everything is generated from `plugins.inspect` and the contracts core exports,
so the reference matches the running bb. Shapes are shown for core contracts;
for a contract another plugin declares, read that plugin's `contract.ts`.

## For agents

Run `bb plugin-api <name>` with a contract, a member such as `threads.get`, or
a search word. In the composer, type `@` and a member name to attach its
reference to a message.
