See an agent's chart, mockup, demo, report, or Markdown document in the conversation without opening a side panel. The agent writes an HTML or Markdown file to the workspace or the thread's storage directory. The plugin shows that file inside the assistant message.

## What you get

- An HTML page shown as part of the reply: no card and no title bar, on the thread's own background, as tall as its content.
- The page in your theme. It gets bb's colours, radius, shadows, and font as CSS variables, and follows a theme or light/dark change live without reloading.
- A button that appears on hover and opens the page on its own in the side panel, in the same theme. Cmd-click, Ctrl-click, or middle-click it to open the raw file in a browser tab instead.
- A formatted Markdown document in a collapsible card with a default height of 224 pixels.
- A clear inline error when the file is missing, too large, or unsupported.

## How it works

The agent emits a message directive that names a source-relative `.html`, `.htm`, `.md`, or `.markdown` file. Omitting `source` defaults to the workspace, and explicit `source="workspace"` is equivalent:

```text
::inline-vis{file="charts/out.html"}
::inline-vis{file="charts/out.html" height="480"}
::inline-vis{file="reports/summary.md"}
::inline-vis{source="thread-storage" file="reports/result.html"}
```

The app fills the `threadView.messageDirective` slot with the `inline-vis` directive. It calls the plugin's `inline-vis.preview` operation, which checks the path, confirms the file exists in the selected source, and returns its address and its text. Files must be at most 5 MiB. Relative assets next to HTML files load as usual.

An HTML frame fits its page: the page reports its content height and the frame follows it, from 80 to 2000 pixels. A `height` on the directive caps the frame, and a taller page then scrolls inside it. A Markdown card uses `height` as the height of its scrolling area.

HTML runs in a sandboxed iframe with an opaque origin. Scripts in the file cannot read the bb page, its cookies, or its storage. A page cannot open windows; when the reader clicks a link to another site, the app opens it in a new tab. Markdown uses bb's renderer with sanitized HTML support.

## For agents

The bundled `inline-vis` skill teaches the agent when to emit the directive, how to lay a page out so it reads as part of the reply, and which theme variables to style with. No account or external service is required.
