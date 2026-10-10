Edit a file in bb instead of only reading it. It applies wherever bb opens a file in a thread's side panel: chat links, the file search, and `bb thread open`. The editor is Monaco, the editor from VS Code. The plugin is off by default; turn it on in Settings.

## What you get

- Tap Save in the file bar to write your edits, including on mobile. Cmd+S, or Ctrl+S on Linux and Windows, also saves. If the file changed on disk since you opened it, the save stops and offers Reload or Overwrite.
- Find in file with Cmd+F or Ctrl+F, multiple cursors, block selection, bracket matching, and code folding.
- Syntax highlighting for about 86 common file types.
- A file tree above the editor (toggle it with the folder button in the file bar) with a filter box. Click a file to open it; right-click to copy its absolute path, relative path, or name.
- Command palette actions for fold, unfold, sort selected lines, and copy the absolute or relative path of the current file.
- Colors from your chosen code theme, light or dark, over bb's own background.

## How it works

The plugin claims common code, configuration, and text extensions, plus `Dockerfile`. Binary files such as images and PDFs stay with bb's own preview, and so do Markdown files, which bb renders. Files larger than 8 MB, and files that are not text, are not opened for editing. Reads and saves go to the machine the file lives on: the thread's workspace, its storage directory, or a path on the host.

There is no language server. Go-to-definition, find references, and type checking across files are not available.
