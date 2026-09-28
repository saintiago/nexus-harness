# Vendored memory package build

`agentic-memory-0.0.0-39340feb.tgz` is the built, revision-pinned package the Nexus Memory
component consumes through its public exports. It is checked in so a fresh Linux checkout installs
the package and its declarations with `npm ci`, without a sibling repository or prototype imports.

Provenance:

- Repository: https://github.com/saintiago/agentic-memory
- Revision: `39340febab6ba1d3c5912778c4a0c37baec9c09f` (main, 2026-09-27)
- Built with the revision's own toolchain: `npm ci && npm run build && npm pack`

`package.json` depends on this tarball as `file:vendor/agentic-memory-0.0.0-39340feb.tgz`, and
`package-lock.json` records the tarball's integrity, so the lockfile pins the exact bytes. Replace
the tarball only together with the dependency and lockfile when moving to another revision, and
keep the revision documented here.
