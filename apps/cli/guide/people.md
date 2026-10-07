# People and sharing

One bb server can be used by several people. Each person is a **user** with a
role: an `owner` manages users, invites and every machine; a `member` works in
their own threads on the machines they may use.

`bb` run on the server machine talks to the server over loopback and acts as
the owner. `bb whoami` shows who a command runs as.

## Invite someone

```sh
bb user invite --name Ada --role member   # prints an invite link that expires
bb user invites                           # invites nobody has accepted yet
bb user revoke-invite <id>
```

The person opens the link in a browser, picks a name and a password, and is
signed in. Only an owner can create or revoke invites.

## Sign a browser in

```sh
bb user sign-in-link                      # a one-time link for yourself
bb user sign-in-link <userId>             # for someone who lost their password
```

Run on the server machine, `bb user sign-in-link` is the way to sign your own
browser in: open the printed URL once, before it expires.

## Manage users

```sh
bb user list                              # id, name, email, role, status
bb user role <userId> owner               # or member
bb user disable <userId>                  # they can no longer sign in
bb user enable <userId>
```

## Who can use which machine

Every machine has an owner and is either **private** or **shared**:

- `private`: only its owner can run threads, terminals and file commands there.
- `shared`: every user can.

```sh
bb machine list                           # SHARING and OWNER columns
bb machine share <machine>                # let every user use it
bb machine unshare <machine>              # keep it to its owner
```

`bb machine show <machine> --json` has `ownerUserId`, `sharing` and `usable`
(whether you may use it). See `bb guide machines` for adding machines.
