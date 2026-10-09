---
name: storage-retention
description: Inspect machine storage, clean up files, and configure automatic thread archive or deletion.
---

# Storage & retention

Enable `bb plugin enable storage-retention`. Both policies default to Never.
All commands return JSON.

```sh
bb storage retention
bb storage retention --archive-after 30 --delete-after 90
bb storage retention --archive-after 30 --delete-after 90 --save --yes
bb storage retention --archive-after never --delete-after never --save --yes
bb storage retention --delete-storage-on-archive true --save --yes
bb storage retention --delete-storage-on-archive false --save --yes
bb storage retention --delete-dev-data-on-checkout-removal true --save --yes
bb storage usage
bb storage usage --rescan
bb storage usage --machine HOST_ID --rescan
bb storage usage --machine HOST_ID
bb storage remove-orphans --machine HOST_ID --yes
bb storage retry-worktree-cleanup --machine HOST_ID
bb storage clear-thread --thread THREAD_ID --yes
bb storage clear-archived-files --machine HOST_ID --yes
```

Without `--save`, retention thresholds only preview affected thread counts.
Days must be whole numbers from 1 to 3650, or `never`. Unspecified settings
preserve their saved values. Saved policies apply across all projects. The
hourly run processes up to 50 trees per action and skips groups with pinned
members. Archiving can remove worktrees including uncommitted changes. Deleting
removes history and thread storage. Preview first and save only when authorized.

Delete thread storage on archive defaults to off. When on, it applies to future
manual and automatic archives while the plugin is enabled; it does not clear
previously archived threads. Conversations and uploaded attachments are kept.
Pinned threads are skipped. Cleanup waits for stopped threads and online
machines; pending cleanup survives reloads and retries every minute, and
unarchiving or deleting the thread cancels it.

`--delete-dev-data-on-checkout-removal` is saved with the policy; removing
`~/.bb-dev` data is not available in this version yet.

`--rescan` measures the thread storage folder of `--machine`, or of every online
machine, and caches the report; usage without `--rescan` reads the cached
reports and never starts a scan. A report has `disk` (total and free bytes of
the volume holding thread storage), `threadStorageBytes`, `threads` (size,
archived, clearable) and `orphans` (folders that belong to no known thread).

Remove-orphans needs a completed scan and removes only folders that the scan
and a fresh recheck both find orphaned. Clear-archived-files empties the storage
folders of archived, stopped, unpinned threads found in the last scan.
Clear-thread empties one stopped thread's storage folder. Retry-worktree-cleanup
deletes again the worktree environments on the machine whose teardown failed or
that stayed retiring for over ten minutes, unless a live thread still uses them. Conversation history
is never affected.

The same actions are operations: `storage-retention.state`, `preview`,
`configure` (`{archiveAfterDays, deleteAfterDays, deleteStorageOnArchive,
deleteDevDataOnCheckoutRemoval}`, null for Never), `run` (one retention pass
now), `usage({hostId?})`, `scan({hostId?})`, `removeOrphans({hostId})`,
`retryWorktreeCleanup({hostId})`, `clearThread({threadId})` and `clearArchivedFiles({hostId})`.

Pin automation target threads to keep them. Disabling the plugin stops scheduled
retention and removes its storage actions.
