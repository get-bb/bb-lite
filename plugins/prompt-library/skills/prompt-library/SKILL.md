---
name: prompt-library
description: Search prompt history and manage starred reusable prompts in BB.
---

# Prompt library

Open **+ → Prompts…** or press **Ctrl+R** ("Search prompts") in a composer.
Search matches starred prompts and recent history. Select **Thread**,
**Project**, or **All**; the scope is remembered per composer kind on this
device. The new-thread composer offers Project and All. Thread searches that
thread's follow-ups; Project searches the prompts that started the project's
threads; All searches the thread starts of every project. Arrow keys select,
Tab switches scope, Enter inserts, and Escape closes. The selected prompt is
previewed below the list with an Insert button.

Click the star or press Cmd/Ctrl+S to star or unstar the selected prompt.
**Star current draft** saves the draft's text. Starred prompts deduplicate by
text, persist across restarts, and sort by most recent use. Inserting into an
empty composer replaces the draft; otherwise the text is inserted at the
cursor. Inserting never sends a message. Only prompt text is kept: mentions and
attachments of history entries are not restored.

Each query word, ignoring case, must match a single word of the prompt:
exactly, as its start, with one typo (words of four or more letters), inside
it, or as an abbreviation that starts at its first letter (`tmln` finds
`timeline`). Letters are never matched across words. Results include up to 20
starred and 30 recent prompts in scope. Without a query, starred prompts come
first, then recent ones. A query returns one ranked list: prompts that start
with the query first, then by match type in that order, then starred prompts
and prompts of the composer's kind (prompts that started a thread in the
new-thread composer, follow-ups in a thread composer), then by relevance (rarer
words, repeated words, and shorter prompts score higher) decayed by age with a
seven-day half-life; a starred prompt's age counts from its last use. A starred
prompt appears once, as its starred row. History contains the user's own
prompts, not agent input. Up to 1000 recent prompts per thread or project are
searched.

## CLI and operations

- `bb prompts search [query...] [--project ID | --thread ID] [--composer new-thread|follow-up] [--json]`; `--composer` defaults to `follow-up`
- `bb prompts list [--json]`
- `bb prompts star <text...> [--json]`
- `bb prompts unstar <id> [--json]`

Plugins call the `prompt-library` contract's operations: `search` takes
`{ query, scope: "thread" | "project" | "global", projectId, threadId,
composer: "new-thread" | "follow-up" }` (all optional) and returns `{ prompts }`,
each row with `kind: "starred" | "recent"`; `create` takes `{ text }` and stars
it; `delete` takes `{ promptId }` and unstars it; `update` takes `{ promptId }`
and marks it used; `list` returns the starred prompts. Core history is read with
`threads.promptHistory` and `projects.promptHistory`.
