Open your bb from another computer and let your other machines reach it. Once this bb is signed in to your getbb.dev account, it answers at `https://<label>.getbb.dev` for anyone signed in to that account.

## What you get

- Remote access to the full bb app through a tunnel. Your bb makes one outbound connection, so you do not open ports or change your router.
- Machine access. A machine added while bb connect is signed in and on receives its own getbb.dev machine credential inside the `bb runner join` command; removing the machine revokes it.
- Port shares. Publish a local HTTP server, such as a dev server, at `https://<label>--<port>.getbb.dev`. The port can be on the server machine or on any connected machine; `bb connect expose <port>` shares the port of the machine the command runs on. The link opens from any device with your session.
- One card under Settings → Plugins → bb connect: state, URL, sign in and out, the remote-access switch, shared ports.

## How it works

`bb connect login` (or the Sign in button) shows a code and a getbb.dev link; confirm the code there and this bb is linked. The credential lives in `<data dir>/connect.json` (mode 0600). The tunnel reconnects after a drop, waits five minutes when another bb takes over the same label, and signs out only when getbb.dev confirms the credential is no longer valid.

`bb connect off` or the switch closes the tunnel and keeps this bb signed in; `bb connect on` reopens it. `bb connect logout` revokes the credential. `bb connect import-legacy --db <old bb.db> --yes` adopts the credential of an original bb install; stop that install first, because getbb.dev allows one tunnel per label.

A share is a machine and a port (`{ hostId, port }`; shares stored before this held only a port and mean the server machine). The share URL names only the port, so one port number is shared from one machine at a time. Ports of the server machine are proxied straight to `127.0.0.1:<port>`. For a port of another machine the server opens a loopback relay listener per share; each request goes to that machine's runner part (`src/runner.ts`) through `connect.shareRequest` (one HTTP request to `127.0.0.1:<port>` there; the answer carries status, headers and up to 1 MiB of body), then `connect.shareChunk` for the rest of the body in chunks of up to 1 MiB (a chunk waits up to 20 s for data, so server-sent events flow), and `connect.shareClose` when the visitor goes away. Request bodies are capped at 32 MiB (413). An offline machine answers 502.

`connect.expose` and `connect.unexpose` take `{ port, hostId? }`; status lists `shares: { hostId, port, url }[]`.

`BB_CONNECT_BASE_URL` points the plugin at another account site (development).
`BB_CONNECT_LINK` holds a ready-made link (the JSON `connect.json` stores) that the plugin uses when
the server has none of its own; a hosted server gets it from the relay (`docs/hosted.md`) and then also
reports running threads to the relay so it is not put to sleep mid-turn.

## For agents

Every thread is told to share servers with `bb connect expose <port>`; the `share-server-links` skill explains the flow. Other commands: `bb connect status`, `unexpose <port>`, `unexpose-all`, `shares`. All take `--json`; `expose` and `unexpose` take `--host <machine id>` to name another machine.

## Limits

Share links open only with your getbb.dev session. WebSockets (including dev-server hot reload) work only for ports of the server machine; for another machine's port an upgrade answers 501. The same port number cannot be shared from two machines at once.
