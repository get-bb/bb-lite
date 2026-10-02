---
name: share-server-links
description: "Expose a local HTTP server through bb connect and give the user its remotely accessible URL."
---

# Share local server links via bb connect

When you start an HTTP server the user should open, give them a bb connect
share URL, not a localhost URL.

1. Check remote access: `bb connect status --json`. If `paired` is false, give
   the localhost URL and mention that remote URLs work once this bb is signed in
   (`bb connect login`). If `enabled` is false, the user turned remote access off
   (`bb connect off`); give the localhost URL and mention `bb connect on`. Do
   not sign in or turn it on yourself unless the user asks.
2. Run `bb connect expose <port>`. It prints the share URL
   (`https://<label>--<port>.<base domain>`); with `--json` it prints
   `{"port": …, "url": …}`.
3. Give that URL to the user as a markdown link. It opens for viewers signed in
   to the owner's getbb.app account; it is not a public link.
4. When the server stops, run `bb connect unexpose <port>`. `bb connect shares`
   lists what is shared and `bb connect unexpose-all` revokes everything.

Only ports of the machine that runs the bb server can be shared. From a thread
on another machine `bb connect expose` fails with code `remote_machine`: give
the user the machine's own address instead, or run the server from a thread on
the server machine.

With `--json` a failure prints `{"ok":false,"error":{"code":…,"message":…}}`.
