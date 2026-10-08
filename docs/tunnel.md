# frp tunnel test

`apps/tunnel` is a second way in to a bb server, built to compare against the relay's Worker and
Durable Object tunnel (`docs/relay.md`): [frp](https://github.com/fatedier/frp) carries the traffic and
a small Node gate in front of it does what the relay's gate does. It runs on Fly as `bb-next-tunnel`
and serves `https://<label>.fly.getbb.dev`. A server linked to getbb.dev answers on both addresses at
once, with the same accounts.

## How a request travels

1. Fly ends TLS for `*.fly.getbb.dev` and hands the request to the gate (`src/gate.ts`, port 8080).
2. The gate reads the `bbr_session` cookie, which the browser sends because the address is under
   `getbb.dev`, and asks the relay who it is (`POST /api/gate/resolve`). Answers stay in memory for
   60 s, so only the first request of a session waits for the relay; a revoked session keeps working
   here for up to that long.
3. It applies the relay gate's rules: sign-in redirect or 401, the foreign-`Origin` refusal, relay
   cookies and `x-bb-gate-*` headers removed, identity headers added, relay cookies dropped from
   `Set-Cookie`. It rewrites `Origin` to the server's relay address, the one public address the bb
   server knows.
4. It forwards to frp's server (`frps`) on loopback, which routes by subdomain to the server's
   client over one multiplexed connection.
5. The client (`frpc`, started by the connect plugin) calls the bb server on loopback with the
   `x-bb-via-tunnel` marker, so the server trusts the identity headers as it does on the relay path.

`frps` asks the gate before it accepts a client (`Login`) or a proxy (`NewProxy`): the client names
its label and sends the server's link credential, the gate checks both with the relay, and a client
may only claim its own subdomain. The gate answers 503 for a server with no client connected.

## The server's side

`BB_CONNECT_FRP=tls://tunnel.fly.getbb.dev:7000` makes the connect plugin start `frpc` next to its
usual tunnel (`plugins/connect/src/frp.ts`). It downloads frp 0.71.0 for Linux or macOS into
`<data dir>/frp`, checks it against a pinned SHA-256, and writes `frpc.json` there (mode 600; it holds
the link credential). `BB_CONNECT_FRPC` names an frpc binary to use instead. The client verifies the
gate's certificate against Node's root certificates.

## Running it

- Tests: `FRP_BIN_DIR=<folder with frps and frpc> pnpm exec vitest run apps/relay` adds a run of the
  real binaries against the relay in Miniflare and a real bb server. Without `FRP_BIN_DIR` that test is
  skipped.
- Deploy: `fly deploy --ha=false` from `apps/tunnel`. The app needs the secret `RELAY_SECRET`, equal
  to the relay Worker's `GATE_SECRET`, a dedicated IPv4 address for port 7000, and a certificate for
  `*.fly.getbb.dev`. DNS: `A` and `AAAA` records for `*.fly`, and the `_acme-challenge.fly` CNAME Fly
  names, all unproxied.

- Compare: `node scripts/tunnel-compare.mjs --data <data dir of a linked server>` times the same API
  calls through both addresses with a machine credential it mints and revokes. `--frp-via
bb-next-tunnel.fly.dev` reaches the gate before the DNS records exist.
- Where the machine runs decides most of the result: a request crosses from the visitor to the gate's
  region and from there to the server. With the gate in `iad` and a server in California the two
  paths took about the same time; with the gate in `sjc` frp answered an API call in about 37 ms
  against 130 to 200 ms through the relay.

## Not there yet

Shares (`<label>--<port>`), the hosted servers' wake and asleep pages, a deadline on the whole
request, and more than one gate machine (a client is known only to the machine it dialled).
