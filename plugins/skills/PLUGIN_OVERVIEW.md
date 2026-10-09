Browse every skill agents can be offered on this bb: skills from plugins, your own and the project's, the provider's native skills and skills you installed. Read a skill's SKILL.md, install one from a git repository or a directory, remove it, or turn it off so agents are no longer offered it.

## What you get

- A Skills page in the sidebar to search, read, toggle, install and remove skills, and to browse a registry.
- `bb skill list|show|install|delete|enable|disable|search`.
- Operations `skills.list`, `get`, `install`, `uninstall`, `enable`, `disable`, `search`, and a `skills.source` slot other plugins fill to offer more installable skills.
- A "Skills registry" setting: the address of a skills.sh compatible registry (empty turns it off).

Installed skills go to the machine's bb skill directory (`<data dir>/skills`), which the composer's `/` and `$` lists already read; disabled installed skills move to `skills/.disabled`. Disabling a plugin's skill removes its directory from what sessions get; disabling a provider-native, user or project skill hides it from the composer, but a provider that reads its own directories may still load it.
