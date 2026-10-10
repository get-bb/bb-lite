# Modal Sandbox

Runs bb threads in Modal sandboxes. It adds the `modal-sandbox` environment kind
and machine provider: creating a thread there builds or reuses the selected
image, creates a sandbox in the configured Modal app, enrolls it as a machine,
starts `bb runner join` inside it and clones the project. Idle machines are
snapshotted and stopped, and restored from the snapshot on resume. The image
must already contain the `bb` CLI. A per-minute sweep forgets stopped sandboxes
and terminates ones left running after their machine was suspended.

Settings: `tokenId`, `tokenSecret`, `appName`, `idleMinutes`. The plugin shows
as needing configuration until the token is set. CLI: `bb modal account
inspect`, `bb modal machine inspect HOST_ID`, `bb modal image
show|set|reset|build`, `bb modal sandbox run|exec|stop` (30-minute debug
sandboxes). The plugin's settings page edits size presets and named images.

The Modal API sits behind `ModalApi` (`modal-api.ts`), picked from the
`modal.api` service. `modal-client.ts` implements it with the `modal` SDK
(pinned to 0.10.0, whose gRPC middleware carries the image build logs); tests
add a fake from an installed scope, which wins over it.
