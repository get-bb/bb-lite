# bb-next relay

`apps/relay` is the public front door for bb servers that have no public address of their own. It is a
Cloudflare Worker, a D1 database and one Durable Object per linked server. A bb server dials out to
it (bb connect) and becomes reachable at `https://<label>.<domain>`; people sign in to the relay once
and the relay tells each server who they are. The server decides who is a member.

It speaks the same account API and tunnel protocol as getbb.app (`packages/tunnel-contract`,
`plugins/connect/src/hosted.ts`), so pointing a server at it is one setting:
`BB_CONNECT_BASE_URL=https://<domain>`, then `bb connect login`.

## What it does

- **Accounts.** Sign-in is GitHub only. `/auth/github` sends the browser to GitHub with a random
  `state` kept in a ten-minute cookie on `/auth`; `/auth/github/callback` checks it, exchanges the code,
  reads the profile and the verified primary email, and upserts the account by GitHub id. A session
  cookie `bbr_session` on the base domain follows (HttpOnly, SameSite=Lax, 90 days; the database holds
  its SHA-256). The Worker needs the secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` of a GitHub
  OAuth app whose callback is `https://<domain>/auth/github/callback`; without them sign-in answers 503.
  The account named by `ADMIN_LOGIN` is the relay's admin.
- **Linking a server.** `bb connect login` starts a device flow (`POST /api/account/link/start`), the
  owner opens `/link?code=…`, picks the address and approves; the server's poll receives its credential
  once. Only accounts allowed to host can approve: the admin, accounts the admin allowed on the
  dashboard, or everyone when `HOSTING=open`. Linking the same address again rotates the credential.
- **The gate** (`<label>.<domain>`). A visitor without a relay session is sent to `/login?next=…`
  (pages) or gets 401 (API). A signed-in visitor is forwarded with `x-bb-gate-auth: session`,
  `x-bb-gate-user-id`, `-name`, `-email`, `-avatar` and `x-bb-gate-owner`; the bb server maps the id to a member,
  or shows "not a member yet" until they open an invite link (`docs/architecture.md`, Trust).
- **Shares** (`<label>--<port>.<domain>`, `bb connect expose`) are for the server's owner only.
- **Machines.** A runner on another machine carries `x-bb-connect-machine`; the relay checks the
  credential belongs to that server and forwards with `x-bb-gate-auth: machine`.

## Isolation

Every server and share is a sibling subdomain running code the relay does not control, so:

- every `bbr_*` cookie is removed from the `Cookie` header before anything is forwarded, and inbound
  `x-bb-gate-*`, `x-bb-via-tunnel` and `x-relay-*` headers are dropped;
- a `Set-Cookie` from a server is dropped when it names a `bbr_*` cookie (with or without a `__Host-` or
  `__Secure-` prefix), carries a `Domain` attribute in any spelling, or looks like several cookies
  joined with a comma;
- the account pages on the apex (`/`, `/link`, `/admin/*`, `/logout`) do not trust `bbr_session`, which
  a page on any subdomain could shadow with a cookie of its own. They read a second, host-only cookie
  (`__Host-bbr_account`) that only the apex can set; the gate on server addresses reads `bbr_session`;
- a state-changing or WebSocket request whose `Origin` is not the address it was sent to is refused at
  the gate (the bb server checks the same), and account forms require the relay's own `Origin`.

## The tunnel object

`TunnelDO` holds the server's tunnel socket and every visitor socket through the WebSocket hibernation
API, with the tunnel heartbeat answered by an auto-response, so an idle server costs nothing while it
stays connected. Stream ids are random and live in socket attachments; in-flight HTTP streams are the
only in-memory state and keep the object awake only while a response is pending. Bodies pass through
still encoded (`encodeBody: "manual"`). A second tunnel for the same server replaces the first (close
1000, "replaced by a new tunnel connection").

Failure handling, ported from the getbb.app gate:

- **A dropped tunnel.** When the tunnel closes with anything but a clean 1000, the object notes
  `tunnelLostAt` and a visitor who arrives within 15 s waits for the server to dial back instead of
  getting 503. A clean close (sign-out, switched off) answers 503 at once.
- **A vanished tunnel.** The object records when a tunnel opened and closed. If a request or a new dial
  finds no tunnel socket although the last one never closed (5 s grace), the object saves that, syncs
  and aborts itself, so an orphaned hibernated socket is dropped and the server redials into a working
  object. The gate retries GET and HEAD against the object twice (50 ms, 250 ms) and answers 503
  otherwise.
- **A revoked link.** `POST /api/connect/disconnect` and linking the same address again close the open
  tunnel (1000, "link revoked"); the old credential is then refused on redial.
- **Deadlines.** The gate answers 504 `gateway_timeout`, naming the stage (`routing` or `tunnel`), when
  no response head exists 120 s after the request arrived; a response that turns up later is
  discarded. The object has the same 120 s limit on a response head.
- **Backpressure.** The tunnel client (`packages/tunnel-client`) stops reading a local response while
  more than 1 MiB is waiting on the tunnel socket.

## Running it

- Tests: `pnpm exec vitest run apps/relay` bundles the Worker, runs it in Miniflare and drives it with a
  real bb server and the real connect plugin.
- Locally: `wrangler d1 migrations apply bb-next --local`, then
  `wrangler dev --port 8799 --var BASE_DOMAIN:relay.localhost:8799`, and start a bb server with
  `BB_CONNECT_BASE_URL=http://relay.localhost:8799`.
- Deployed as the Worker `bb-next` with the D1 database `bb-next` on `getbb.dev`
  (`apps/relay/wrangler.jsonc`): the apex is a custom domain and `*.getbb.dev/*` is a zone route.
  `wrangler deploy` from `apps/relay` ships a new version; `wrangler d1 migrations apply bb-next
--remote` applies new migrations. The route only works with a proxied wildcard DNS record
  (`AAAA * 100::`) on the zone, which needs DNS edit rights. bb connect defaults to
  `https://getbb.dev`; `BB_CONNECT_BASE_URL` points a server at another relay.

## Not there yet

Other sign-in providers; public or member-visible shares; an account page beyond the server list.
