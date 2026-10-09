# BB guide

Control the BB introduction and bundled agent skills in Settings → Installed
plugins → BB guide. The plugin and all six settings default to enabled.

- `introduction`: send the BB CLI, thread, and link instructions.
- `skills`: make the selected skills available.
- `bbCli`: include `bb-cli` (shipped with the CLI).
- `pluginAuthoring`: include `bb-plugin-authoring` (shipped by Plugin tools).
- `skillCreator`: include `skill-creator` (shipped here).
- `submitPlugin`: include `submit-a-plugin` (shipped here).

Change them in the app or through the `plugins.updateSettings` operation
(`PUT /api/v1/plugins/bb-guide/settings`). Changes apply when an agent session is
next assembled; they do not erase instructions from an existing conversation.

A disabled skill removes the skill directory that holds it from agent
sessions. The plugin also adds a **Plugin** item to the composer's plus menu
that starts the message with "Create a new bb plugin that ".
