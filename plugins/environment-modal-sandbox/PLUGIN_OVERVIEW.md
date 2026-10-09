# Modal Sandbox

Runs bb threads in Modal sandboxes. It adds the `modal-sandbox` environment kind
and machine provider: creating a thread there builds or reuses the selected
image, creates a sandbox in the configured Modal app, enrolls it as a machine,
starts `bb runner join` inside it and clones the project. Idle machines are
snapshotted and stopped, and restored from the snapshot on resume.

Settings: `tokenId`, `tokenSecret`, `appName`, `idleMinutes`. The plugin shows
as needing configuration until the token is set. CLI: `bb modal account
inspect`, `bb modal machine inspect HOST_ID`, `bb modal image show|set|reset`.

The Modal API sits behind `ModalApi` (`modal-api.ts`), picked from the
`modal.api` service.
