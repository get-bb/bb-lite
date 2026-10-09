# Storage & retention

Off by default. Both retention policies default to Never. The plugin owns the
policy, previews, the hourly retention run (`bb.background.schedule`), run
summaries and the `bb storage` CLI. It rebuilds archive and delete groups from
`threads.list` rows and acts with `threads.archive` and `threads.delete`.

Its runner part measures and deletes files on a machine (`measure`, `clear`);
the server part calls it with `bb.runners.call`. Scans are cached per machine in
the plugin's key-value storage and classify each folder under the machine's
thread storage root as a thread's storage or an orphan. Delete storage on
archive queues archived threads and empties their storage once they are stopped,
retrying every minute.
