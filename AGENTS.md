# dsh-phalanx development

Follow `docs/architecture.md`, including all ten laws. Integrate the external
DeepSeek Harness only through its official CLI, configuration, HTTP and
WebSocket seams. The supported revision is declared in `runtime-versions.json`;
do not edit, vendor or import its private implementation.

Run affected acceptance and regression tests, typecheck, lint and both builds
before committing. Preserve quick fake-port use-case tests and public-entry
acceptance. Run the complete quick suite for broad changes. Actual DSH behavior
requires real DSH tests; container and installed-host claims require Linux.
Use deterministic handshakes or injected clocks for functional assertions.

Keep credentials, real deployment configuration, host identities and user data
out of source and history. Use fictional values in examples and fixtures.
Review changes independently for architecture and intended behavior, fix
findings, and repeat affected checks. Keep commit identities public.

## Documentation map

Read this map before changing documentation. Put current behavior in the matching
owner below. Write version changes only under `releases/`; use `vX.Y.Z` or
`<version>` in generic command examples. Change English/Chinese pairs together,
with matching heading levels and counts. Run `corepack pnpm docs:check` locally;
the same check is required in CI independently of the fast-check cache. The
mechanical version guard covers the current minor release series; review other
version narration against this map as well.

| Document | Reader | Owns |
| --- | --- | --- |
| [README](README.md) / [中文](README.zh-CN.md) | Evaluators | Purpose, highlights, architecture overview, quick install and navigation |
| [Installation](docs/install.md) / [中文](docs/install.zh-CN.md) | Deployers | Host requirements, first installation and initialization |
| [Deployment operations](docs/operations.md) / [中文](docs/operations.zh-CN.md) | Operators | Storage, HTTPS, updates, service diagnostics, backup and recovery |
| [Administrator guide](docs/admin-guide.md) / [中文](docs/admin-guide.zh-CN.md) | Administrators | Models, groups, member instances, libraries, catalogs and publication |
| [Member guide](docs/member-guide.md) / [中文](docs/member-guide.zh-CN.md) | Members | Sign-in, DSH workspace, platform apps, plugin settings and environment recovery |
| [Plugin and MCP access](docs/plugin-access.md) / [中文](docs/plugin-access.zh-CN.md) | Administrators | Plugin upstreams, shared service bindings, MCP configuration and credentials |
| [Skill execution](docs/skill-execution.md) / [中文](docs/skill-execution.zh-CN.md) | Administrators | Skill execution, dependencies, credential bindings and test runs |
| [Architecture](docs/architecture.md) | Contributors, agents | Ownership, engineering laws, data boundaries and system update transaction |
| [Contributing](CONTRIBUTING.md) | Contributors, maintainers | Development, DSH verification, Linux acceptance, candidate and release workflow |
| [Admin UI design](admin-ui/DESIGN.md) | Admin UI contributors | Admin and entry page components, layout, responsive states and themes |
| [Native DSH UI design](docs/dsh-ui/DESIGN.md) | DSH integration contributors | DSH slots, primitives, theme tokens and platform app center |
| `releases/notes/` and `releases/acceptance/` | Users, release maintainers | Version changes, one-time upgrade steps and completed acceptance evidence |

If new content does not fit an existing owner, propose the document change to the
user before creating another document. Record public engineering constraints
in Architecture.
Keep the installation filenames and `recoverable-system-updates` anchor stable.
Installed versions link to this entry point for operations guidance. Preserve historical
acceptance records. Diagram sources and generated theme variants belong together
under `docs/diagrams/`.
