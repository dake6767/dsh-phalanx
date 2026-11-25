# Community platform architecture

Seven directories under `src/` assign every source file to one layer. Fast lint
checks mechanical boundaries; independent review checks policy, state ownership
and behavior at official seams.

## Layers and dependencies

| Directory | Responsibility | May import |
| --- | --- | --- |
| `domain/` | Pure values, configuration and shared contract types | domain |
| `ports/` | Capabilities needed by use cases | domain, ports |
| `use-cases/` | Account, entry, instance, model and network decisions | domain, ports, use-cases |
| `dsh/` | Official DSH protocol and configuration facts | domain, ports, dsh |
| `adapters/` | External I/O and port implementations | domain, ports, dsh, adapters |
| `inbound/` | HTTP/WS entry, authentication, account management and private proxies | domain, ports, dsh, use-cases, inbound |
| `composition/` | Wire the community graph and own application startup/shutdown | all layers |

## Subsystem invariants

Detailed per-subsystem invariants live under `docs/architecture/` so this core document stays focused on layers, engineering laws, persistence foundations, gates and key architectural decisions:

| Document | Owns |
| --- | --- |
| [Official DSH seam ownership](architecture/dsh-seams.md) | Frozen DSH seam table, profile writer locks, native preset/plugin policy and authenticated install proofs |
| [Persistence views and store ownership](architecture/persistence-views.md) | Registered synchronous in-process views, invalidation fences, master-key bootstrap and PostgreSQL store owners |
| [Runtime guarantees and boundaries](architecture/runtime-boundaries.md) | Process/container host, MCP services, plugin library/access, member spaces, skills, execution, service preview and paused expert interfaces |
| [System update transaction and host admission](architecture/system-update.md) | Release manifests, capacity-aware cleanup, backups and PostgreSQL recovery, nftables fence, host admission and root executor |

## Official DSH seam ownership

DSH remains an external frozen dependency. Upgrade seam owners under `src/dsh/` against its official CLI, configuration, HTTP and WebSocket interfaces before changing transport. See [Official DSH seam ownership](architecture/dsh-seams.md) for the complete seam table, profile writer lock protocol, `NativePluginHistory` and signed native-install proofs.

## Ten laws

1. **Dependencies follow the table.** Every control-plane source file belongs
   to one layer. Domain and use cases do not call HTTP, podman, SQLite or the
   filesystem directly. Inbound code does not construct storage or runtime
   implementations. Lint checks imports and common dynamic escape paths.
2. **The composition root only wires.** It creates adapters, injects ports and
   owns startup and shutdown. It does not decide policy, parse HTTP requests
   or hold business state. Review its branches and state ownership, including
   code reached through callbacks.
3. **Business branches use typed state.** Error messages and failure strings
   are for display and diagnostics. A branch on their text is a violation;
   use a typed error or discriminated union. Lint checks known message
   comparisons, substring checks and regular-expression tests.
4. **DSH official seams have one owner each.** Put each CLI, configuration,
   plugin, HTTP or WebSocket seam in one named `dsh/` module. Lint catches
   repeated protocol literals outside that layer. Review import paths and
   other literals that a syntactic check cannot identify.
5. **External I/O has one exit.** Filesystem, SQLite and podman execution
   belong in adapters. A use case receives a port; an inbound route receives
   its collaborators. Lint checks direct module imports. Review indirect I/O
   and ensure a capability has one adapter owner.
6. **Shared mutable state has a named owner.** When two responsibilities need
   one Map, Set or changing value, a service with an interface owns it.
   Review closure captures, recovery paths, concurrency and cleanup; a type
   declaration alone does not establish ownership.
7. **The management API contract has one source.** Server response types and
   browser consumption share `domain/admin-contract.ts`. Frontend pages may
   define view-local state. Lint rejects new exported response shapes in
   `admin-ui/src/community-api.ts`; review any new API shape elsewhere.
8. **Every use case has a quick fake-port test.** The gate enumerates
   `use-cases/*.ts` and requires a corresponding `tests/*.spec.ts`. The test
   must actually exercise the module through injected collaborators; review
   checks that it is not an empty import or only a real DSH test.
9. **Real DSH tests assert real seam facts.** Keep actual DSH behavior,
   isolation and security, plugin loading, container cleanup and restart recovery
   on the real seam. Put control-plane state transitions on the main seam
   with substitutes. Review test intent when moving or adding scenarios.
10. **Functional tests do not use elapsed wall time as their assertion.**
    Use injected clocks and deterministic handshakes for order and windows.
    Timing measurements belong to separate performance or validation modes.
    Review waits, retries and sleeps. Repeat new timing-sensitive tests under
    local CPU throttling before committing, then restore normal conditions.

The source limit is 500 nonblank, noncomment lines per file. The admin UI
limit is 600; the test limit is 800. Comments and blank lines do not count.
These are growth alarms, not proof that responsibilities are well separated.
Prettier at width 160 (`pnpm lint` checks it) keeps the count honest: one
statement per line, no dense one-line blocks. HTML templates and data fixtures
can have a permanent exemption when a comment explains their data nature.
Source modules have no permanent exemption. The only other entry point is the
ratcheted ledger in `architecture-exemptions.json` (`fileSize`): files that
formatting revealed above their limit, each with a ceiling and the ticket that
splits it. A ceiling only goes down, the ledger never gains a file, and an entry
must be removed once its file fits the normal limit.

`UsagePolicy` owns gateway attempt lifetimes, admission and retention. The composition root supplies one policy to plugin upstreams, MCP tools, execution, web tools and shared models. Attempts capture starting member/group and finish once. Tool rows whitelist metadata, with the first execution argument as the only retained argument. Model observation forwards original bytes before bounded synchronous JSON/SSE parsing, retains cumulative counters and known partial usage, and writes member/model/hour totals only at completion. Missing usage remains unknown; pure refusals do not add unknown usage.

## Persistence pattern

Platform facts live in PostgreSQL behind one persistence foundation.

- **Unit of work.** A use case that changes several facts at once receives a
  `PlatformUnitOfWorkPort`; `run` hands it repositories bound to one transaction,
  and every write commits together or not at all. Downloads, artifact preparation
  and container work happen before `run`; the transaction records only results
  that are already ready. `PostgresUnitOfWork` builds each repository from a
  factory with that transaction's SQL and the platform key owner.
- **Repositories read and write rows.** New stores address rows by key and guard
  concurrent edits with a row or aggregate revision (`UPDATE … WHERE revision=$n`).
  Earlier snapshot stores (whole-state read, child-table rewrite) move to rows
  as their domain moves into the database.
- **Schemas share one ordered registry.** `PLATFORM_SCHEMAS` in
  `adapters/platform-schema-registry.ts` registers the core `dsh_phalanx` first.
  Each schema has an ordered migration list and its own `schema_migrations`;
  preparation applies them in registry order under one transaction and migration
  lock. The core retains `PLATFORM_MIGRATIONS` and `PLATFORM_SCHEMA_VERSION` in
  `adapters/platform-schema.ts`. Append migrations; never edit or reorder released
  entries. All new tables belong to a registered schema. Isolated test composition
  can supply additional schemas, which are absent from the production inventory.
  The installed `platform-facts schemas` CLI reads their names and recorded
  versions without initializing anything; database unavailability exits 2. The small
  executor reads source-declared schema versions and saved download choices through
  generated read-only adapters using the source release's connection, key and TLS
  owners. It does not initialize the platform or retain facts between requests.
  Rotation readiness authenticates both protected configurations and the master key,
  inspects the selected database without preparing it, and fences pending journals,
  staged files and protected-file identities. The root executor uses this fact
  before maintenance and to recover only a legacy rotation rejected before initialization.
  Status polling skips database reads while checking the live image and process;
  check shares that request's host and status projection. It samples saved sources
  and schema versions in one read-only repeatable-read transaction, bound to the
  source and protected-file identities for that request only. Schema sampling
  failure does not replace a conclusion that requires no schema. Subsequent
  prepare, apply and verification read fresh facts.
- **Protected values are declared per table.** A store declares
  `protectedTable(name)` and encrypts each value at its record and field through
  the cipher the database hands out; the position is authenticated data, so a
  copied value fails to decrypt. `PlatformDatabase` exposes no encrypt/decrypt of
  its own. Envelopes already in deployed databases stay readable; a fixture of
  previously written envelopes guards the context shape.
- **One store lifetime.** `PlatformStoreLifecycle` gives every store one
  initialization, a serialized write queue and a close that drains accepted writes
  before releasing state; composition closes stores before the database.
- **Advisory locks are named.** Every lock key lives in `adapters/advisory-locks.ts`;
  a gate rejects a bare lock number elsewhere. Account writes share one
  transaction lock.

Synchronous in-process views are permitted only where a caller cannot await and must be registered with their source of truth and post-commit invalidation rules. See [Persistence views and store ownership](architecture/persistence-views.md) for the complete view registry and per-store ownership invariants.

## Architecture gates

`architecture-exemptions.json` holds only the ratcheted size ledger above; no
other rule can be exempted. Architecture rules apply to TypeScript in `src/`,
`admin-ui/src/` and `tests/`. The repository lint command runs ESLint and
Prettier, then checks architecture assets such as CSS. General ESLint
configuration also covers executable fixtures, container tooling and scripts.
Architecture rule samples run in `tests/dependency-gate.spec.ts`. Keep quick
test coverage next to each use case and review changes to the gates independently.

## Signed catalogs

`SuiteCatalogGallery` fetches and verifies the same catalog for the skill,
plugin and MCP galleries. The Ed25519 signature covers the canonical JSON
of the received document after removing its top-level `signature` field.
The optional `galleryTags` is included in the signed data. Each entry has a separate content hash
and compatibility range. Gallery tags refer to entry kind and stable ID. Tag
changes leave the installation identity intact. The online reader discards
invalid optional metadata and keeps usable signed entries. The publication
check rejects invalid metadata.

The MCP reader validates a single declarative adapter. A remote HTTPS service
can bind one credential supplied by the administrator. A shared Node.js service
declares a GitHub source archive by full commit and SHA-256, and a relative
entry point. The platform generates the preparation command and uses the saved
service configuration for runtime admission. New import and update requests pin
the verified entry version and content hash. The confirmed candidate retains
those settings during preparation, connection test and promotion. The candidate can
reuse a saved credential only when the HTTPS origin and credential bindings match.
The platform fetches the catalog outside the MCP write queue and rechecks actor
authority and the selected target when accepting the write.

Older platforms skip the MCP kind. A newer platform can read a verified
catalog with no MCP entries. Existing Amap and 12306 imports retain their
saved settings, credentials and relationships. The legacy version is equivalent
to the first external version only when the saved and declared connection
settings match the known historical configuration. Missing, unreachable or
rejected catalog targets leave local runtime and access decisions intact.

## Runtime guarantees and boundaries

The rootless container is the integrity boundary for each user's private home, workspace and configuration; process mode is development-only and makes no isolation promise. Platform credentials stay outside member spaces and enter container bootstraps only through stdin or authenticated platform gateways.

- Process host, container labels, MCP library, catalog updates, shared carriers and stdio wrappers: [Process host and MCP runtime](architecture/runtime-boundaries.md#process-host-and-mcp-runtime)
- Public listener supervision, system status, account and group transactions: [Public entry, system status and accounts](architecture/runtime-boundaries.md#public-entry-system-status-and-accounts)
- Plugin library, isolated preparation, native delivery, preinstalls and access projections: [Plugin library, delivery and access](architecture/runtime-boundaries.md#plugin-library-delivery-and-access)
- Member entry, lifecycle, model/web/network gateways, voice, storage guard and environment recovery: [Member spaces, lifecycle, models and network](architecture/runtime-boundaries.md#member-spaces-lifecycle-models-and-network)
- Skill library, execution control, runtime dependencies and opaque service previews: [Skills, execution and service preview](architecture/runtime-boundaries.md#skills-execution-and-service-preview)
- Paused expert, usage and contribution visibility plus expert definitions: [Paused interfaces and expert definitions](architecture/runtime-boundaries.md#paused-interfaces-and-expert-definitions)

Developer setup and target-specific verification are in [the contribution guide](../CONTRIBUTING.md).

## Key decisions

**Independent community codebase.** This repository owns its source history, release inputs and supported interfaces. DSH stays external and pinned, with one owner per official seam. Independent evolution keeps changes reviewable without a shared-core or feature-matrix prerequisite; source drift and deliberate manual integration are accepted costs.

**Rootless user spaces.** Installed deployments run one rootless Podman user instance per account, with private home/workspace mounts and loopback listeners. The authenticated network return path pins public IPv4 destinations and rejects known and declared host aliases; a missing declaration fails closed, while an explicit empty alias list permits normal public egress. Development mode offers no isolation. Rootless operation requires Linux host preparation and real container/network verification; it does not certify arbitrary plugins.

**Administrator-owned shared models.** Administrators own provider credentials, manual model lists, each supplier's upstream protocol and the default selection. Each supplier's protocol becomes its DSH provider `api`; the gateway accepts that protocol's path and authentication shape, forwards the request unchanged to the supplier endpoint and never translates between protocols. Stable opaque identities route requests using a provider snapshot captured at admission; disabled selections fail without silent fallback. Catalogs update through official DSH seams, while keys remain in platform storage. Ordinary personal-provider settings are unavailable; terminals, user plugins and unrelated settings remain available, including external model access through user code. The gateway is not a prohibition on all external model traffic. Administrator model lists declare each model's input types as text or text and images; the platform writes that declaration into the DSH model entry, which enforces it at session admission, `read_image` and subagent image delivery. The platform does not infer capability from provider metadata.

**Stable authenticated user-space entry.** Each account has a durable `/app/<spaceId>/` path; the ID grants no authority. Every HTTP request and WebSocket upgrade checks the current account and space before forwarding. DSH cookies are scoped to the admitted mount, with Secure under HTTPS. The public URL and index tap use official seams, preserving native query/hash bookmarks; the cost is explicit proxy and cookie ownership rather than modifying DSH routing.

**Independent platform pages.** Login, first-administrator initialization and instance recovery are lightweight server-rendered pages independent of management bundles and native DSH. Shared appearance is applied before paint. Authentication, expiration and recovery authority remain server responsibilities; credentials stay in the fragment/form and are not retained in display preferences. The platform must still run: this is not offline login. A small shared renderer is maintained to keep recovery available when larger applications fail.

Browser account switching is owned by `inbound/platform-signed-in-accounts.ts`
and `inbound/signed-in-account-routes.ts`. A signed, HttpOnly, root-path cookie
remembers at most ten stable-space markers and their original platform sessions;
there is no server-side account-list store. The current session cookie remains
the only entry authority. Switching rechecks account availability, space and
session epoch, promotes the original token without extending expiry, forgets
the runtime session and clears browser storage when the account changes.
Removing an entry does not delete its platform account; sign-out retains its
marker without the token, while sign-out-all clears both the list and current
session. Mutations retain the same-origin POST boundary. Remembered credentials
are stripped before forwarding HTTP or WebSocket traffic to DSH.

`domain/platform-account-sync.ts` carries type-only browser notifications.
Receiving tabs navigate to an independent authenticated notice document, unloading
their old live connections; current account/space checks remain the security
boundary. Restored cached documents reload before resuming operation. Platform
appearance uses a separate root-path preference cookie, migrates legacy local
storage once and survives account-change storage clearing. These preferences
are independent of the native DSH theme.

## System update transaction

The system update is a fixed combination of platform, management UI and DSH
image. Preparation keeps the old service running. Application immediately closes
work admission and stops the platform and its owned user instances. There is no
idle-task waiting, countdown or historical downgrade operation.

A shared transaction owner implements prepare, apply, status, cleanup and recover through
one host port and installation mutex. Selection pins the complete manifest bytes
and identities; apply never follows latest again. The root-only journal saves each
phase before its external effect. A completed, durable backup is
required before starting the target. Recovery after an interrupted switch restores
that backup and validates the old process, artifact, image and local readiness.
An original upgrade failure remains a failure even when restoration succeeds.
Restoration also saves its commit boundary before reopening writes; later recovery
starts and verifies without copying the backup again. Failed recovery blocks new preparation
and retains the current operation for server recovery.
After the durable commit point, recovery starts and verifies the new version and never rolls
back writes that may have resumed. Recovery failure leaves work admission closed.

See [System update transaction and host admission](architecture/system-update.md) for the full compatibility protocol, owned cleanup, backup and PostgreSQL recovery, nftables admission fence, Debian/Ubuntu host admission and root executor invariants.

### Rebuildable data root

`domain/data-root-layout.ts` is the single inventory of allowed artifact, projection and transient runtime paths. `inspectDataRoot` checks populated installations against those exact subroots and refuses unknown siblings or redirected roots. Durable PostgreSQL data and default user spaces live in the separate per-deployment `.durable` namespace; explicit user volumes retain their configured location. Master keys and operator recovery receipts stay beside the protected database configuration. Deleting projections preserves those durable stores and all immutable artifacts. Current execution consumes independently prepared runtime dependencies; declared CommonJS module directories are exposed through the runner's controlled `NODE_PATH`.
