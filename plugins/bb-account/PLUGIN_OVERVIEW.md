Tells this bb and its plugins which getbb account it is signed in to. Remote access (bb connect) holds the sign-in; hosted services, such as bb cloud's thread titles, read the account and make their requests through bb account.

## What you get

- `bb account status`, `bb account login [--wait]` and `bb account logout`, the same sign-in as `bb connect login` and `bb connect logout`.
- One account other plugins read: the `bb-account.status` operation and the `bb-account.changed` event.
- Requests to getbb's `/api/ai/` services as this server through the `bb-account.fetch` operation. The calling plugin never sees the credential.

## How it works

Run `bb account login`, open the link it prints, sign in with GitHub and approve. bb picks up the approval on its own. `bb account logout` revokes this server's credential, so remote access and hosted services stop until you sign in again. Add `--json` to any command for machine-readable output.

## Requirements

The bb connect plugin, which holds the sign-in and the server credential.
