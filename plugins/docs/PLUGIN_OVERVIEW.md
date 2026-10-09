Collaborate with agents on editing Markdown docs inline. Edit directly inside threads, approve/reject proposals from an agent, and undo/redo changes.

## What you get

- A Docs panel with a vault picker, a searchable document list, and a Markdown editor with preview. Type a path and press New to create a document.
- Vaults. Each vault is a folder on a host. A new install starts with a Personal vault at `~/Notes`. Add vaults on other machines that are enrolled as bb hosts with `bb docs vault-add`.
- `@` mentions. Type `@` in the composer to attach a document. The agent gets its current content, hash and proposal version at send time.
- Editable document cards in agent replies (`::docs{vault path title}`). Edit Markdown in the timeline or open the same document in a tab.
- Review agent proposals with a live diff. Accept or reject them, then undo or redo.
- Copy the current draft from the header.

## For agents

Agents get the `docs` skill and the `bb docs` command. They list vaults with `bb docs vaults` and read files with `bb docs read`. They edit with `bb docs pull`, `bb docs status`, and `bb docs push`. Push uses version checks, so a concurrent edit is reported as a conflict instead of being overwritten.

Agents can propose changes with `bb docs propose` without replacing the saved document. Proposal updates and approval actions check versions to protect concurrent edits.
