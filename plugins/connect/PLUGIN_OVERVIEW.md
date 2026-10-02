Open your bb from another computer and let your other machines reach it. Once this bb is signed in to your getbb.app account, it answers at `https://<label>.getbb.app` for anyone signed in to that account.

## What you get

- Remote access to the full bb app through a tunnel. Your bb makes one outbound connection, so you do not open ports or change your router.
- Machine access. A machine added while bb connect is signed in and on receives its own getbb.app machine credential inside the `bb runner join` command; removing the machine revokes it.
- Port shares. Publish a local HTTP server of the server machine, such as a dev server, at `https://<label>--<port>.getbb.app`. The link opens from any device with your session.
- One card under Settings → Plugins → bb connect: state, URL, sign in and out, the remote-access switch, shared ports.

## How it works

`bb connect login` (or the Sign in button) shows a code and a getbb.app link; confirm the code there and this bb is linked. The credential lives in `<data dir>/connect.json` (mode 0600). The tunnel reconnects after a drop, waits five minutes when another bb takes over the same label, and signs out only when getbb.app confirms the credential is no longer valid.

`bb connect off` or the switch closes the tunnel and keeps this bb signed in; `bb connect on` reopens it. `bb connect logout` revokes the credential. `bb connect import-legacy --db <old bb.db> --yes` adopts the credential of an original bb install; stop that install first, because getbb.app allows one tunnel per label.

`BB_CONNECT_BASE_URL` points the plugin at another account site (development).

## For agents

Threads on the server machine are told to share servers with `bb connect expose <port>`; the `share-server-links` skill explains the flow. Other commands: `bb connect status`, `unexpose <port>`, `unexpose-all`, `shares`. All take `--json`.

## Limits

Only ports of the server machine can be shared; share links open only with your getbb.app session.
