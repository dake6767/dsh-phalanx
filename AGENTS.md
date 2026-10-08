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

| Document | Reader | Owns | Excludes |
| --- | --- | --- | --- |
| [README](README.md) / [中文](README.zh-CN.md) | Evaluators, deployers | Purpose, four core benefits, architecture overview, quick install, navigation, community/license statement | Version narration, operating/recovery steps, backup paths |
| [Installation](docs/install.md) / [中文](docs/install.zh-CN.md) | Deployers, administrators | Installation, storage, services, HTTPS, updates/recovery, environment reset, diagnostics | Historical behavior, upgrade chains |
| [Architecture](docs/architecture.md) | Contributors, agents | Layers, seam owners, ten laws, runtime guarantees, current key decisions, update transaction | Schema history, superseded alternatives |
| [Contributing](CONTRIBUTING.md) | Contributors, maintainers | Development, real DSH verification, general CI/candidate/promotion contract | Per-version chapters |
| AGENTS.md | Agents | Engineering rules and this documentation map | Product operating instructions |
| `releases/notes/` and `releases/acceptance/` | Users, release maintainers | Version changes, one-time upgrade steps, executed acceptance evidence | General reference duplicated from the owners above |

If new content does not fit an existing owner, propose the document change to the
user before creating another document. Keep public architectural constraints in
Architecture; decisions are recorded in private planning, not new public ADRs.
Keep the installation filenames and `recoverable-system-updates` anchor stable:
installed versions link to that main-branch help location. Preserve historical
acceptance records. Diagram sources and generated theme variants belong together
under `docs/diagrams/`.
