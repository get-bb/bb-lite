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
- **Hosted servers.** An account that may host can create a bb server on Fly from the dashboard; the
  relay starts, stops and deletes it (`docs/hosted.md`).
- **Machines.** A runner on another machine carries `x-bb-connect-machine`; the relay checks the
  credential belongs to that server and forwards with `x-bb-gate-auth: machine`.

- **Lookups for another gate.** `POST /api/gate/resolve` on the apex answers, for a label, the server
  and its relay address, the account behind a `session` token, whether a `credential` links that
  server, and the id of a `machine` credential. It needs `Authorization: Bearer <GATE_SECRET>` and
  answers 404 without the Worker secret `GATE_SECRET` or with a wrong one. The frp gate on Fly uses it
  (`docs/tunnel.md`).

## MCP and OAuth

An MCP client (ChatGPT, Claude, any other) connects to `https://<server address>/mcp`. The relay apex
is the OAuth authorization server; the gate in front of the server checks the access token and
forwards the call to the bb server's `mcp` plugin. The paths, header names and the scope live in
`packages/tunnel-contract/src/mcp.ts`, shared by both gates.

- **Discovery.** `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`
  on a server address name the relay apex as authorization server; `/.well-known/oauth-authorization-server`
  on the apex lists the endpoints. `/mcp` without a token, or with one that is refused, answers 401
  with `WWW-Authenticate: Bearer ... resource_metadata="..."`.
- **Sign-in.** `GET /oauth/authorize` is a page of the app (`app/routes/oauth.authorize.tsx`, never
  framed, never cached). The client is a client id metadata document: an `https` URL with a path, no
  IP address or loopback host, fetched without following redirects, at most 5 KB, within 5 seconds, as
  JSON, naming itself and its redirect URIs. The redirect URI must match one of them exactly (a
  loopback one may differ in port), PKCE with `S256` is required, and `resource` must be the `/mcp`
  URL of a server **the signed-in person owns**, on either of its addresses (`<label>.<BASE_DOMAIN>`
  or, with `FRP_BASE_DOMAIN` set, `<label>.<FRP_BASE_DOMAIN>`). The page reads its facts from
  `GET /api/dashboard/oauth/consent` and answers with `POST /api/dashboard/oauth/decision`, which
  like every dashboard POST needs the account cookie and the apex as `Origin`.
- **Tokens.** `POST /oauth/token` (form encoded, `no-store`) trades the code (60 seconds, single use,
  stored hashed) for an access token (one hour) and a refresh token (60 days, stored hashed). The
  access token is signed with the Worker secret `MCP_TOKEN_SECRET` and bound to the owner, the server,
  the grant and the resource, so a token issued for one address of a server is refused on the other.
  A refresh rotates the refresh token; the old one still answers with the same successor for 60
  seconds (a retry), and after that using it revokes the whole grant. `POST /oauth/revoke` takes
  either token. One person keeps at most 10 live grants per client and server; older ones are revoked.
  Without `MCP_TOKEN_SECRET` the token endpoint and `/mcp` answer 503 and the consent page says why;
  `POST /oauth/revoke` still revokes the grant behind a refresh token.
- **The gate.** With a valid token the gate forwards `/mcp` to `/api/v1/plugins/mcp/http/mcp` with
  `authorization`, every cookie and any `x-bb-gate-*` the caller sent removed, and `x-bb-gate-auth:
oauth`, `x-bb-gate-oauth-scope`, `x-bb-gate-oauth-grant` and `x-bb-gate-oauth-client` set. It reads
  the grant on every call, so a revocation holds at once. A request from outside for the plugin's
  local path, however it is encoded, gets 404 whoever sends it. On a share address these paths are
  ordinary paths. A sleeping hosted server is not woken by an MCP call; it answers 503 until a visit
  wakes it.
- **Grants.** The dashboard lists them as "Connected apps" (`POST /api/dashboard/apps/<id>/revoke`).
  The bb server reads and revokes its own with its link credential, on the apex or on its address:
  `GET /api/connect/mcp/grants` and `POST /api/connect/mcp/grants/revoke` with `{ "grantId" }`.
- **The frp gate** cannot read D1 and does not hold the signing secret: it sends the token and the
  resource it serves to `POST /api/gate/resolve` (`oauth`, `resource`) and gets the grant or `null`.

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

## The app

The pages on the apex (`/`, `/login`, `/link`) are a TanStack Start app in `apps/relay/app`, rendered
on the Worker and hydrated in the browser. It uses the bb app's components (`@bb/shared-ui`) and its
theme (`packages/shared-ui/src/theme.css`, which `apps/app` imports too) and follows the system's
light or dark setting.

- `src/server.ts` is the Worker's entry. It asks the relay first (`route` in `src/worker.ts`: every
  server address, `/api/*`, `/auth/github*`), then the app's static assets, then the Start handler.
  Assets are served by the Worker, not ahead of it (`run_worker_first`), so a request for `/assets/…`
  on a server's address still reaches that server.
- The app reads through server functions (`app/data.ts`) that call the relay's own code, and writes
  with `fetch` to the dashboard API below, then reloads its route.
- `/api/dashboard` (`src/dashboard.ts`) is the account API the app and the tests share: `GET` answers
  the signed-in account's servers, people (admin only) and what it may create; `GET /link?code=` and
  `POST /link` show and answer a `bb connect login` request; `POST /servers` creates a hosted server
  and `POST /servers/<id>/{wake,sleep,update,delete}` acts on one; `POST /people/<id>` lets the admin
  allow or revoke hosting; `POST /logout` signs out. It trusts only the host-only account cookie, and a
  `POST` must carry the apex as its `Origin`.
- The pages the gate answers with on a server's address (starting, asleep, nothing here) cannot load
  the app, so `src/pages.ts` keeps them as self-contained HTML in the same colours.

## Running it

- Tests: `pnpm exec vitest run apps/relay` bundles the relay without its app, runs it in Miniflare and
  drives it with a real bb server and the real connect plugin. After `pnpm --filter @bb/relay build`,
  `RELAY_BUILT=1 pnpm exec vitest run apps/relay` runs the same tests against the built Worker, plus
  one that loads the app's pages.
- Locally: `wrangler d1 migrations apply bb-next --local --config wrangler.jsonc`, put
  `BASE_DOMAIN=localhost:5173` (and GitHub or Fly settings to try those) in `apps/relay/.dev.vars`, then
  `pnpm --filter @bb/relay dev`. Start a bb server with `BB_CONNECT_BASE_URL=http://localhost:5173`.
- Deployed as the Worker `bb-next` with the D1 database `bb-next` on `getbb.dev`
  (`apps/relay/wrangler.jsonc`): the apex is a custom domain and `*.getbb.dev/*` is a zone route.
  `pnpm --filter @bb/relay run deploy` builds and ships a new version; `wrangler d1 migrations apply
bb-next --remote --config wrangler.jsonc` applies new migrations. The route only works with a proxied
  wildcard DNS record (`AAAA * 100::`) on the zone, which needs DNS edit rights. bb connect defaults to
  `https://getbb.dev`; `BB_CONNECT_BASE_URL` points a server at another relay.
- `.github/workflows/deploy-relay.yml` does the same on every push to `main` that touches `apps/relay`,
  `packages/tunnel-contract` or `packages/shared-ui` (and on demand): typecheck, the relay tests, the
  build, the tests again on the built Worker, migrations, deploy, then a check that `/login` answers.
  It needs the repository secret `CLOUDFLARE_API_TOKEN` (Workers Scripts, Workers Routes and D1 edit).

- MCP needs three things on a deployment: migration `0005_mcp_oauth.sql` (the deploy workflow applies
  migrations), the Worker secret `MCP_TOKEN_SECRET` (`wrangler secret put MCP_TOKEN_SECRET`, a long
  random value used for nothing else; changing it signs every app out), and `FRP_BASE_DOMAIN` in
  `wrangler.jsonc` naming the frp gate's domain so tokens can be issued for those addresses.

## Not there yet

Other sign-in providers; public or member-visible shares.
