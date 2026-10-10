See who changed what on this bb, through which door and which plugin.

## What you get

- A record of every operation that changes something: creating a thread, sending a message, stopping, archiving and deleting.
- Each record names the person it was done for, where it came from (the app, the CLI, an agent in a thread), the plugins it passed through, and any plugin that changed or refused it.
- Owners see every record. Members see their own.

## What it does not cover

- Reads are not recorded unless a plugin answered or refused one.
- A plugin that reaches files or the network directly, without going through a bb operation, leaves no record.

## For agents and scripts

Use the `bb audit` command:

- `bb audit list` prints the newest records first.
- `bb audit list --user <id> --op threads.send --plugin tasks --thread <id>` narrows them.
- `bb audit list --json` prints the records as JSON.
