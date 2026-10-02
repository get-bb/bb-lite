# Task attachments

Read this file when a task needs files or image references.

## Choose the owner

A task key adds a file to the task. A comment ID adds a file to that comment.

For a comment attachment, create the comment as JSON and use its ID:

```sh
comment_id=$(
  bb tasks comment ABC-12 \
    --body "Screenshot of the failing step." \
    --json | jq -r '.comment.id'
)
bb tasks attachment add "$comment_id" --file ./screenshot.png
bb tasks attachment add "$comment_id" --file ./trace.log
```

`attachment add --json` returns `{ attachment, url }`. To show an image inline,
put `![name](url)` in the description or a comment.

## Find and fetch files

`bb tasks show ABC-12 --json` lists every attachment of the task and its
comments under `attachments`. Fetch one with
`bb tasks attachment get <attachment-id> --out <path>`.

Files are removed in the Tasks app, not from the CLI.

## Paths and limits

In a thread, `--file` and `--out` are read and written on the thread's machine.
The path must be inside the thread's workspace and the file at most 512 KiB.

Outside a thread, paths are on the server machine and files can be up to 25 MB.
