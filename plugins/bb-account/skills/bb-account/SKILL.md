---
name: bb-account
description: "Sign this bb in to or out of its getbb account with bb account, and check which account remote access and hosted services use."
---

# bb account

The builtin bb account plugin tells this bb and its plugins which getbb
account it is signed in to. The sign-in itself and the server credential
belong to bb connect; `bb account` and `bb connect` sign in to the same
account. Hosted services such as bb cloud make their requests through bb
account and never see the credential.

## Check the account

`bb account status [--json]` prints the handle and this server's URL, or
`Not signed in`. With `--json` it prints
`{signedIn, handle, serverUrl, hosted, login}`: `hosted` says whether hosted
services can make requests as this server, and `login` is the pending browser
sign-in, if any.

## Sign in

- `bb account login [--json]` starts a browser sign-in. It prints a getbb
  link and the code, then returns. Open the link on any device, sign in with
  GitHub and approve. bb finishes signing in on its own.
- `bb account login --wait [--json]` waits for that sign-in to be approved,
  denied, or expire, and exits non-zero unless it signed in.

## Sign out

`bb account logout [--json]` revokes this server's credential, forgets it
locally, and cancels a sign-in still waiting for approval. Remote access and
hosted services stop until you sign in again. To stop remote access but stay
signed in, use `bb connect off`.

Settings → bb connect shows the same account with Sign in and Sign out.
