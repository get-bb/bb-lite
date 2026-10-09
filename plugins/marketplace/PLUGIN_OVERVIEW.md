# Marketplace

Find plugins in one or more plugin catalogs (the official bb catalog by default, or any https URL or
local file listed in the `catalogs` setting), and install, update and remove them. An entry's source
is a git repository (a pinned ref, or a version range resolved against its tags with an optional tag
prefix, and an optional subdirectory) or an npm package with a range. Installing goes through
`plugin-dev.install`, which refuses a plugin whose `engines.bb` does not admit this bb.

Each install records where it came from (catalog, source, ref, range, version) so `updates` can find
a newer version in range. Install, update and remove are owner only and audited.

CLI: `bb marketplace search [query]`, `install <id> [--version <range>]`, `updates`,
`update <id>`, `list`, `remove <id>`. App: Settings > Marketplace.
