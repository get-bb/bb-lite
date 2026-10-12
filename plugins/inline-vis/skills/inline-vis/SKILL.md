---
name: inline-vis
description: "Show a newly created or updated HTML chart, table, diagram, mockup, demo, or report, or a Markdown plan, summary, or notes from the workspace or thread storage inline in BB chat with the inline-vis directive."
---

# Inline previews

When the user should see an HTML page or a Markdown document **inline in the
assistant message**, write (or update) a source-relative file, then emit this
**message directive** as its own block (not inside a fenced code block):

```text
::inline-vis{file="demo.html"}
::inline-vis{file="notes.md"}
```

Omitting `source` defaults to the workspace. Explicit `source="workspace"` is
equivalent. For a read-only thread-storage artifact, write the document to
`$BB_THREAD_STORAGE/reports/result.html`, then emit its storage-relative path:

```text
::inline-vis{source="thread-storage" file="reports/result.html"}
```

The reader sees an HTML page as part of your reply: no card, no title bar, on
the thread's own background, as tall as its content. Put the directive where
the page belongs in the reply. The reader already sees the page, so do not
announce it, say where it is, or restate it; write only what it does not say.

## Rules

- `source` is optional and must be `workspace` or `thread-storage`.
- `file` is relative to the selected source (e.g. `demo.html`,
  `charts/out.html`, `notes.md`). Workspace paths are relative to the current
  workspace; thread-storage paths are relative to `$BB_THREAD_STORAGE`. Never
  put an absolute path in the directive.
- `.html`, `.htm`, `.md`, and `.markdown` files are accepted.
- `height` is optional, a whole number of pixels from 80 through 2000.
  - HTML: omit it and the frame fits the page. Set it to cap the frame; a
    taller page then scrolls inside it.
  - Markdown: the height of the scrolling card; omit it for the 224px default.
- Keep files small (under the 5 MiB document limit).
- Emit the directive only after the file exists on disk in the selected source.
- Prefer `thread-storage` for read-only generated reports and other artifacts
  that should not modify the workspace.
- Do **not** put the directive inside backticks or a markdown code fence, or it
  stays literal text.
- Incomplete streaming syntax stays literal until the closing `}` arrives — emit
  a complete directive in one piece when possible.

## Laying out an HTML page

The frame has no border and is as wide as the reply column (about 710px on
desktop, about 360px on phones). Its left edge lines up with your reply text.

- Leave `html`, `body`, and the outermost element with no background colour.
  The page sits on the thread's background. This overrides general style
  preferences such as a fixed black page background.
- Use a fluid width with no horizontal padding on the outermost element, and
  no outer card, border, or banner title: the page is part of your reply.
- If a box needs its own background (a mock of a specific screen, a panel
  that must stand apart), give it at least 16px of padding on every side and
  `var(--radius)` corners, so content never touches its edge.
- Give charts fixed pixel heights rather than heights that scale with width.
- Let content set the page's height. Avoid viewport-based heights such as
  `100vh` or `height: 100%` on `html` or `body`; the frame follows the page, so
  they can make it grow again and again.

## Theme

bb injects its active theme as CSS custom properties on `:root`. They follow
the user's theme and light/dark mode live, so style with them instead of
fixed colours:

- Surfaces and text: `--background` (identical to the thread around the
  frame), `--foreground`, `--muted`, `--muted-foreground`,
  `--subtle-foreground`, `--card`, `--card-foreground`, `--popover`,
  `--popover-foreground`, `--surface-raised`, `--surface-recessed`.
- Controls: `--primary`, `--primary-foreground` (solid buttons), `--secondary`,
  `--secondary-foreground`, `--accent`, `--accent-foreground` (neutral hover
  surface), `--border`, `--input`, `--ring`.
- Colour: `--brand` (the theme's one accent), `--destructive`,
  `--destructive-foreground`, `--destructive-text`, `--warning`,
  `--warning-text`, `--success`, `--attention`, `--diff-added`,
  `--diff-removed`.
- Charts: `--chart-1` … `--chart-6`, a categorical series.
- Shape and type: `--radius`, `--shadow-xs`, `--shadow-sm`, `--shadow-md`,
  `--shadow-lg`, `--font-sans`, `--font-mono`.

The base stylesheet sets the page's background, colour, and font from these
(14px, the app's own sans face), sets `body` margin to 0, and hides the page's
scrollbar. Your own CSS overrides it.

## What a page can do

- Inline and external CSS/JavaScript are supported. Remote images, fonts,
  media, fetches, and WebSockets are allowed subject to normal browser CORS,
  mixed-content, and remote-server policies. Relative assets next to the file
  load from the same source.
- Scripts run in a sandboxed frame with an opaque origin and cannot access the
  bb page, cookies, or storage.
- A link to another site opens in a new browser tab when the reader clicks
  it. A link to an anchor (`#section`) moves within the page.
- Markdown uses BB's renderer with sanitized HTML support.

If the plugin is disabled or the path is invalid, users see the original
directive source or an inline error from the plugin.
