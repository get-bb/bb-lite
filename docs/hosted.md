# Hosted bb servers

A signed-in relay account that may host can create a bb server that runs on Fly, at an address under
the relay's domain, from the dashboard at `https://<domain>/`. The relay (`apps/relay`) does all of it:
it creates the machine, hands the server its tunnel credential, notices visits, puts an unused server to
sleep and starts it again when its owner opens it. A hosted server is an ordinary bb server; the only
code it runs that a self-hosted one does not is in the connect plugin (below).

## What a hosted server is

- One Fly app per server, named `bb-next-<server id>`, holding one machine and one volume. The app is
  the isolation boundary: nothing is shared between two servers.
- The machine runs the image built from `hosted/Dockerfile`: Node, git, build tools, the bb server and
  web app from this repository, and the Claude Code and Codex CLIs. It has no public address and no
  services; the server binds loopback and is reached only through its tunnel to the relay.
- The volume is mounted at `/data`. A stopped machine starts again from the image, so only `/data`
  survives: the server's data directory is `/data/bb` and the home directory of the `bb` user it runs as
  is `/data/home`, which keeps agent sign-ins and their session files. Packages an agent installs
  outside `/data` are gone after a sleep.
- Agents are not signed in. The owner signs Claude Code or Codex in from a terminal on the server.

## Lifecycle

`servers.hosted_state` is `NULL` for a server someone linked themselves, else:

- `creating` → `running`. `POST /hosted/create` (dashboard form) checks the account may host and has
  fewer than `HOSTED_PER_ACCOUNT` hosted servers, inserts the server with a fresh credential, then asks
  Fly for the app, the volume and the machine. The machine's environment carries `BB_CONNECT_LINK`, the
  link `bb connect login` would have produced, so the server dials the relay on its first start. The
  browser is sent to the new address, which shows "Starting your bb server" until the tunnel is up.
  The relay's account is the server's owner (`x-bb-gate-owner`), so there is no second sign-in.
- `failed`: a Fly call failed while creating. The dashboard shows the reason; delete and create again.
- `running` → `stopped`. Every 15 minutes (cron trigger) the relay stops machines whose `active_at` is
  older than `HOSTED_IDLE_HOURS` (24). `active_at` moves when the owner loads a page or makes a write
  request (at most every five minutes), and when the server reports a running thread: the connect
  plugin of a provisioned server posts to `/api/connect/activity` every ten minutes while any thread is
  `starting`, `active` or `stopping`. The dashboard's "Put to sleep" stops it at once.
- `stopped` → `running`. A page load by the owner starts the machine and shows the starting page,
  which reloads until the tunnel is back. Other requests answer 503 `server_asleep` and do not start
  it, so a forgotten tab cannot keep a server awake, and neither can anyone but the owner.
- `stopped` → deleted. After `HOSTED_DELETE_DAYS` (30) asleep the relay deletes the Fly app with its
  machine and volume, then the server row. The dashboard shows the date. "Delete" does it at once.

If the machine is `running` but its tunnel is gone (a crash, a Fly host restart), a page load by the
owner asks Fly to start it again, at most every 15 seconds.

## Settings

Worker variables (`apps/relay/wrangler.jsonc`): `FLY_ORG`, `FLY_IMAGE`, `FLY_REGION`, `FLY_CPU_KIND`,
`FLY_CPUS`, `FLY_MEMORY_MB`, `FLY_VOLUME_GB`, `HOSTED_IDLE_HOURS`, `HOSTED_DELETE_DAYS`,
`HOSTED_PER_ACCOUNT` (1). The secret `FLY_API_TOKEN` is an org-scoped token for `FLY_ORG`; without
it the dashboard offers no hosted server and nothing here runs. `FLY_API_URL` points the relay at
another Machines API (the tests use a fake one).

## The image

`.github/workflows/hosted-image.yml` (run by hand) builds `hosted/Dockerfile` and pushes it to
`registry.fly.io/bb-next-image` as `latest` and the commit, creating the `bb-next-image` app that holds
it when missing. It needs the repository secret `FLY_API_TOKEN`. A machine keeps the image it was
created with; nothing upgrades existing servers yet.

## Not there yet

Upgrading a hosted server to a new image; letting members, not only the owner, wake a server; a warning
before deletion; choosing a size or region per server; per-account billing or limits beyond the count.
