# Server parity recording

A recorded conversation with the real TypeScript server
(`apps/server`), for replaying against the Rust server. All data is
synthetic: echo provider, temp data directory, temp git repository.

## Regenerate

```sh
cd apps/server
env -i PATH="$PATH" HOME=/tmp TMPDIR=/tmp \
  node --conditions=source --import tsx ../../scripts/rust-parity/record-server.ts [outDir]
```

`scripts/rust-parity/record-server.ts` scrubs `BB_*`, `ANTHROPIC_*`,
`CLAUDE_*`, `OPENAI_*`, `CODEX_*` and `GIT_*` from its environment, then sets
`BB_DATA_DIR` to a new temp directory, `BB_SERVER_PORT=0`, `HOME` to a temp
directory and the git identity and dates to fixed values. It writes a fixed host id
(`host_parity000000`) into the data directory. It builds the server with
`createServer` and a local runner with only the echo adapter, so no title
fallback is installed. The clock (`now`) starts at `1800000000000` and moves
forward 1000 ms before every request, so timestamps are deterministic. It
removes the temp directory when it finishes. To run only some scenarios, set
`PARITY_SCENARIOS=a,b`.

To compare two recordings (or a recording and a replay), run:

```sh
node --import tsx scripts/rust-parity/normalise-parity.ts <in> <out>
diff -r -x id-map.json <outA> <outB>
```

## Files

- `conversation.json`: the ordered steps. Each step has `scenario`, `step`
  (1-based within the scenario) and `kind`:
  - `http`: `{request: {method, path, query, body}, response: {status, body}}`.
    JSON bodies are parsed. A non-JSON response body is recorded as
    `{contentType, length, sha256}`. An empty body is recorded as `null`.
    `/health` is outside `/api/v1`. One request deliberately sends the string
    `{not json` as its body.
  - `wait`: what the recorder waited for before the next step.
    `thread-settled` means `activeTurnId` was null, the status was `idle` or
    `error`, and the `turn/completed` count had grown since the previous wait.
    `observed` holds the status at that point. Other waits are `turn-active`
    and `pending-interaction`.
  - `ws`: a message received on a `/ws` socket. There is one socket per
    subscription: `thread-list`, plus `thread-detail:<threadName>` for each
    thread. Each socket's messages are written in arrival order when its
    scenario ends (they are batched; they are not interleaved with the HTTP
    steps).
  - `error`: a scenario threw (none in the committed recording).
- `threads/<name>.json`, captured when the scenario that created the thread ends:
  - `thread`: the raw `threads` row.
  - `events`: every stored event, decoded by the server's own reader
    (`listEvents` + `decodeEvents`), as `{event, meta}` entries.
  - `timeline`: `{query, status, body}` responses of
    `GET /threads/:id/timeline` for these queries: the default;
    `includeNestedRows=true`; `summaryOnly=true`; `segmentLimit=2`; the
    follow-up page (`beforeAnchorSeq`/`beforeAnchorId` from the first row of the
    previous page); and `afterSequence=3`.
  - `turnSummaryDetails`: the `turn-summary-details` response for the first
    `turn` row, or `null`.
  Threads that the lifecycle scenario deletes have no file.

Keys are sorted everywhere. Array order is the server's.

## Normalisation a replayer must apply

1. **Temp paths**: the recorder has already replaced the data directory, the
   repository and the temp root with `$DATA_DIR`, `$REPO` and `$TEMP`, and
   `host:port` with `$SERVER_HOST`. This applies to requests and responses.
   A replayer substitutes its own paths into requests before sending, and the
   same placeholders into responses before comparing.
2. **Generated ids**: `<prefix>_<10 lowercase alphanumerics>` (`thr_`,
   `evt_`, `proj_`, `src_`, `env_`, `sec_`, `pint_`, `qmsg_`, `phist_`,
   `creq_`, `tpv_`, ...). Map each id to `<prefix>#<n>` in first-seen order,
   reading `conversation.json` first and then the thread files sorted by
   name. Ids embedded in strings are mapped too. For example, managed branch
   names `bb/<slug>-thr_xxx` and workspace paths `$DATA_DIR/workspaces/thr_xxx`
   contain the thread id. A replayer must also rewrite ids in later requests
   through the same mapping: a request uses the id a previous response
   returned, so replace the recorded id with the replay's id for the same
   `<prefix>#<n>`.
3. **Echo runner keys**: a 10-hex per-turn key, followed by `-t<n>`, `-i<n>`
   or `-t<n>:turn`. These appear in turn ids, item ids, call ids and
   `parentToolCallId`. Map the hex part in first-seen order and keep the
   suffix.
4. **UUIDs** (`providerRequestId` is `<uuid>:<n>`): map in first-seen order.
5. **Timeline cursors** (`anchorId: "timeline-v3:<base64url JSON>"`):
   these embed the thread id and the workspace path. Decode them and
   normalise the contents. Never replay a recorded cursor; take it from the
   replay's own previous response.
6. **`modifiedAtMs`** in `/files/read`: this is the file's real mtime. Ignore it.
7. **Host**: the host id is fixed. The host name and platform come from the
   machine. Treat the `hostname`/`platform`/`homeDir`-style fields in
   `/hosts` and `/system/config` as environment-specific. The recorded
   name is `bee` (`name`, `environmentHostName`). Also treat the inherited
   `PATH` as environment-specific: it appears as `value` entries in the
   `/settings/machine-environment` response.
8. **Commit SHAs**: these are stable only while the git author and committer
   dates are pinned (the recorder pins them through `GIT_*_DATE`).

With these rules applied, two consecutive recordings were byte-identical
(apart from `id-map.json`).
