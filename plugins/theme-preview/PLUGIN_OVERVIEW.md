See a theme on bb surfaces before you commit to it, and find contrast problems while you still edit the file.

## What you get

- A **Theme Preview** panel in the sidebar with a theme dropdown and a light or dark switch.
- A mock **Preview** screen (sidebar rows, messages, diff, status chips, composer) painted with the selected theme.
- A **Components** section with buttons, inputs, switches, chips, a dialog and a menu over a scrim.
- A **Style sheet** that lists each resolved token with its value and a WCAG contrast ratio against the surface it sits on.
- A live reload. Each save of a plugin theme's CSS file repaints the app (the host refreshes the theme's versioned style sheet), and while the panel is open the preview follows the active theme and each change of it.

## How it works

The panel lists the built-in palettes and the themes installed plugins declare in their manifests, with swatches read from each theme's CSS. Choose a theme in the dropdown to activate it app-wide. Contrast rows are measurements for guidance. The plugin never creates, edits, or repairs a theme file.

## For agents

The bundled `bb-theme-authoring` skill explains where a theme file lives, the token groups, and the checks to run. Agents load a theme plugin with `bb plugin add <dir>` and activate a theme with `bb settings set theme <id>`. Work in a split: the agent edits the CSS on one side and you watch the preview on the other.
