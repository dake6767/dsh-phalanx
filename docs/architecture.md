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

## Official DSH seam ownership

| Frozen seam | Owner | Caller/transport |
| --- | --- | --- |
| Expert preset projection, roster and pinned standard tools | `dsh/expert-preset.ts`, `dsh/expert-base-tools.ts`, `dsh/expert-plugins.ts` | `adapters/member-experts.ts`, `adapters/expert-status.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Protected MCP include and prompt-boundary hot refresh | `dsh/member-mcp.ts` | `adapters/mcp-projection.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Web CLI arguments | `dsh/cli.ts` | `adapters/community-runtime-driver.ts`, `dsh/container.ts`, generated image CMD |
| Private web-profile paths and patch layout | `dsh/profile-layout.ts` | `adapters/community-profile.ts`, `dsh/container.ts` |
| Non-root container identity, mounts and confined pasta return path | `dsh/container.ts` | `adapters/community-runtime-driver.ts` |
| Isolated npm installation and package artifact preparation | `dsh/plugin-preparation.ts` | `adapters/plugin-preparer.ts` |
| Uploaded package manifest inspection | `dsh/plugin-archive.ts` | `adapters/plugin-archive-inspector.ts` |
| Native bundle inventory, install and removal RPCs | `dsh/plugin-manager-protocol.ts` | `adapters/member-plugin-manager.ts`, `adapters/dsh-plugin-rpc.ts` |
| Access entry identities, lazy values and startup config merge | `dsh/managed-plugin-access.ts` | `adapters/plugin-access-syntax.ts`, `adapters/managed-plugins.ts` |
| Managed bundle patch conversion and protected includes | `dsh/managed-plugin-patch.ts` | `dsh/plugin-preparation.ts`, `adapters/managed-plugins.ts` |
| Self-installed bundle entry discovery and owned yielding patches | `dsh/plugin-coordination.ts` | `adapters/plugin-coordination.ts` |
| Offline plugin activation precheck through native inventory | `dsh/plugin-precheck.ts`, `dsh/plugin-service-observer.ts` | `adapters/plugin-preparer.ts` |
| CLI readiness and launch URL | `dsh/readiness.ts` | `adapters/runtime-process.ts` |
| Launch-token exchange cookies | `dsh/launch-token.ts` | `adapters/dsh-session.ts` |
| Session RPC, native mux frames and activity query | `dsh/session-protocol.ts` | `adapters/dsh-session.ts`; native traffic passes through the entry unchanged |
| Anthropic Messages transport, bounded usage observation and default gateway URL | `dsh/model-protocol.ts` | `adapters/community-model-upstream.ts`, `inbound/community-model-gateway.ts` |
| DeepSeek Search and Fetch API transport, member paths and upstream headers | `dsh/web-tools.ts` | `adapters/community-web-tools-upstream.ts`, `inbound/community-web-tools-gateway.ts` |
| Legacy profile defaults; workspace invocation overlay | `dsh/community-profile.ts` | `adapters/community-profile.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Web environment reset carriers | `dsh/community-environment.ts` | `adapters/community-environment.ts` |
| Global contribution tool, foreground confirmation and embedded guide | `dsh/contribution-tool.ts` | `adapters/community-platform-plugin.ts` |
| Native plugin detail contribution slots and new-session draft | `dsh/community-plugin-contributions-client.ts` | `dsh/community-platform-client.ts` |
| Best-effort platform skill-result observation and report endpoint | `dsh/skill-usage.ts` | `adapters/community-platform-plugin.ts`, `adapters/community-runtime-driver.ts`, `inbound/usage-report-gateway.ts` |
| Protected platform plugin and invocation patch | `dsh/community-platform-plugin.ts` | `adapters/community-platform-plugin.ts`, `dsh/container.ts` |
| Native custom-market bundle policy through authenticated Connection routes | `dsh/native-plugin-policy.ts` | `dsh/community-platform-plugin.ts` |

DSH remains an external frozen dependency. Upgrade these seam owners against its
official interfaces before changing transport. Unrelated native Settings, account-login surfaces and user plugins belong to each member. Shared model supply belongs to platform administration through the official managed include in `dsh/shared-models.ts`.
The built-in custom plugin market bundle is omitted from native bundle discovery
and its enable request is refused. Protected invocation patches disable its host
and client entries even when a member edits bundle selection. Other bundle
operations retain native Gateway validation and behavior; members can still
install their own plugins.

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
  Status polling skips database reads while checking the live image and process;
  check shares that request's host and status projection. It samples saved sources
  and schema versions in one read-only repeatable-read transaction, bound to the
  source and protected-file identities for that request only. Schema sampling
  failure does not replace a conclusion that requires no schema. Subsequent
  prepare, apply and verification read fresh facts.

The root executor owns an independent rootless Podman Unix API service for
image inspection. Each inspect reads actual image facts and retains the existing
image checks; only the authenticated transport is reused. UID, GID, peer PID,
start ticks, owned process group, executable and socket URI bind the peer.
Changes to the Podman configuration discard that service; executor shutdown
closes the connection, reaps its service and removes its owned runtime directory.
Standalone installer invocations retain the CLI inspection path.
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

### Registered in-process views

By default a store reads the database. A synchronous view is allowed only where a
caller cannot await, and each one is listed here with its source of truth and
invalidation.

| View | Owner | Synchronous reader | Source of truth | Refreshed |
| --- | --- | --- | --- | --- |
| Session signing key | `PostgresSessionKey` | session and plugin-download HMAC | `session_signing_key` | loaded once at startup; never changes |
| Shared models | `PostgresSharedModelStore` | model and web-tools upstream routing | `shared_model_*` | after each committed save; startup reloads |
| Gateway token index | `PostgresCommunityModelAccess` | model gateway admission (inside the account fence) | `model_access_tokens` | after each committed issuance; admission rechecks the account in PostgreSQL |
| MCP policy facts | `PostgresMcpFacts`, assembled by `createMcpStorage` | `McpServices.captureLocalPolicy` fence | MCP service metadata, encrypted-field fingerprints, group grants, member selections/preferences, catalog receipts, runtime bindings and account/group parents | invalidate after COMMIT and publish a consistent read-only snapshot before the write resolves, including parent cascades; rollback never publishes. The view contains no plaintext secrets. Row revisions and encrypted-field fingerprints keep its version stable across reopen while invalidating secret-only changes. Failed refresh makes synchronous readers unavailable until initialization succeeds; ordinary queries read rows on demand |
| Plugin authorization invalidation | `PostgresPluginLibraryStore`, `PostgresPluginGrants`, `PostgresPluginSelections`, `PostgresPluginUpstreams`; composed by `PluginLocalCopies.revision` | `PluginUpstreamAccess` synchronous account registration fence | plugin library, grants, choices and upstream rows | a generation scoped to library, grants, choices, upstreams and account/group parents advances after successful autocommit or COMMIT, including parent cascades, before the write resolves; unrelated usage and download writes do not invalidate admission; rollback does not advance it. Admissions capture it before asynchronous reads and recheck during registration and after the account transaction; mismatches undo reversible registration. No plugin configurations or credentials are cached |
| Skill library, packs and assignments | `PostgresSkillFacts`, assembled by `createSkillStorage` | `MemberEffectiveSkills` synchronous projection expander; `SkillExecutionOwners.get/identities` | skills, packs, ordered members, group grants, member choices and their account/group parents | every successful write invalidates synchronously after COMMIT, releases the writer connection, then awaits one consistent read-only snapshot before resolving; rollback never publishes. Concurrent refreshes discard outdated generations. A failed refresh leaves synchronous readers unavailable until `ready()` succeeds; ordinary repositories read rows on demand |
| Expert definitions and ownership | `PostgresExpertFacts`, assembled by `createExpertStorage` | `Experts.authorizationSnapshot/version` in plugin and MCP admission fences | expert definitions and ordered capability/model references, grant/selection headers, account/group permission facts and capability parents | invalidate after COMMIT, release the writer connection and publish one consistent read-only snapshot before resolving; rollback never publishes. Failed refresh rejects synchronous readers. Ordinary expert lists, plans and management revisions query rows on demand |
| Download sources | `PostgresDownloadSources` | plugin and runtime-dependency preparation, contribution host checks, catalog address | `download_sources`, else the installed choice in the local configuration | after each committed save; startup reloads |
| Runtime dependency facts | `PostgresRuntimeFacts`, assembled by `createRuntimeStorage` | dependency `ready/state/version`, frozen member startup plans and MCP admission | `runtime_dependencies` | invalidate after COMMIT, then publish current rows before the write resolves; rollback does not publish. Failed refresh makes synchronous reads unavailable until initialization succeeds; ordinary queries read rows on demand |
| Catalog plugin preparation claims | `SuiteCatalog` | `PluginLibrary` synchronous package admission fence | accepted `catalog_installs` task identity, `pluginPackage` and progress status, held by its live preparation job | acquired after task admission or progress COMMIT and before preparation; released when the owning job drains. Startup recovery ends interrupted preparations and clears claims. No library row, configuration or secret is cached |

Plugin upstream admission reads the registered invalidation view synchronously.
Unavailable MCP or dependency views reject admission and projection reads; they do
not establish that a service was removed. Reconciliation preserves existing MCP
carriers until current facts can be read, while cancellation and idle reclamation
remain active. Catalog preparation rechecks temporary unavailability with one
cancellable timer rather than recording a preparation failure.
Internal diagnostic runtime lookup maps confirmed service removal, lost admin
access and unavailable preparation to absence; public diagnostics keep their
business errors, while uncertain storage reads still propagate.
MCP management progress and retained skill-source queries read current dependency
rows asynchronously, so a refreshing admission view cannot turn those ordinary
reads into missing services or failed uploads. Ordinary dependency binding checks
also query rows asynchronously and share the same current-version and public-row
validation as synchronous readiness. Accepted MCP management writes wait for
projection publication on typed temporary unavailability; shutdown cancels that
wait without undoing committed settings. Catalog operations retain their durable
pending-intent retry owner.
Dependency preparation likewise retains its committed ready version and busy
lease while unavailable publication reads retry; each retry rechecks preparation
ownership and cancellation before publishing again.
Stopping that post-commit retry preserves the ready facts for projection recovery
on the next startup.
Member skill expansion and skill execution owner lookup read the explicit committed skill views above; ordinary skill repositories read PostgreSQL rows on demand and return Promises. Execution configurations query owner rows on demand and keep no configuration view. MCP local-policy capture and expert authorization use their explicit committed policy views. Contribution intake and confirmation read PostgreSQL rows on demand. When a store moves to PostgreSQL, its registered synchronous view must refresh after commit before publication; a synchronous fence never awaits. Each new view is registered in this table.

`PlatformDatabase` owns PostgreSQL connections, transactions and ordered migrations across the registered platform schemas. `PostgresUsageRecords` stores tool rows, model-hour totals and self-reported skill-day counts with shared retention settings. Group sub-buckets preserve attribution across membership changes; queries aggregate them for the selected range. Only fully expired aggregate buckets are pruned. Gateway completion awaits persistence; shutdown drains admitted attempts and pending writes before closing the database.

`FilePlatformSecrets` owns the local master-key file and AES-256-GCM envelope encryption, including record-bound associated data and wrapped data keys. `FilePlatformDatabaseConfig` stores the encrypted database credential outside the platform data root. Startup verifies the existing key and database registry; a missing or mismatched key fails without generating a replacement. Composition opens these owners before serving business requests and closes them after draining work. First-install listeners accept only invitation-authorized setup before database selection; readiness stays false and business owners remain uninitialized. `BootstrapDatabase` commits the protected connection choice and binds the shared database before any owner initializes. Read-only connection probes and installer readiness do not run migrations. A stable deployment identity and dedicated session advisory lock admit one production owner; independent operator connections do not claim that lock. Lost ownership invalidates borrowed transactions and stops the application. Activation failure also closes the graph; restart reconstructs all owners from the committed selection.

`PostgresSharedModelStore` owns protected shared-model settings and their initialized
plaintext view. Saves stage the official runtime include, commit revision-checked
PostgreSQL changes, update memory, then publish the watched catalog last. A failed
post-commit publication keeps the saved fact and reports pending publication;
startup and the next save recover from the latest database revision. Provider keys
are omitted from projections and management replies; replies expose configuration
status and a short suffix, and blank writes retain the stored key.
`PostgresCommunityModelAccess` commits encrypted space-bound gateway tokens before
publishing its synchronous lookup index. Issuance locks the current account;
request admission still rechecks account identity and revocation in PostgreSQL.
`PostgresSessionKey` generates and loads the shared encrypted signing key before
session or plugin-download signing can run. Shutdown drains these owners before
closing their shared database. These secrets have no JSON or environment backend.

`PostgresPluginUpstreams`, `PostgresMcpStore`, `PostgresPluginAccessStore` and
`PostgresExecutionConfigurations` separate configuration metadata from record/field-bound
encrypted envelopes. Plugin owners read on demand and compare explicit package revisions for merged writes. MCP and execution owners publish their registered views only after commit; shutdown drains accepted writes before the shared database closes. Upstream diagnostic
requests are encrypted as opaque JSON, including arbitrary body keys. MCP current and
candidate configurations and plugin rollback snapshots have separate envelope identities.
MCP retains referenced historical literals as encrypted fields after credential changes;
their classification and response masks survive rotation and reopen. Removing every
connection reference collects those retained literals.
Contribution records and complete adoption decisions commit through `ContributionTransactions`.
The reviewed library, configuration, protected values, distribution receipts and competing
pending decisions share one SQL transaction. Artifact preparation precedes it; projection
and collection follow COMMIT. Repeating an adopted identity returns its durable result
and rebuilds current projections without replaying old configuration. Original contributor
identities remain in history after account deletion; pending rows are removed with their
live author. `PostgresContributionSetups` remains an on-demand row adapter for protected
setup compatibility, with independently frozen legacy envelope identities. Production
adoption no longer persists a setup draft or file intent.

Catalog installation, replacement and update prepare artifacts through `SuiteChanges`,
then commit capability rows, assignments, protected configuration, expert references,
installation metadata and bounded request receipts through `SuiteTransactions`.
`SuiteRetirement` removes or detaches ownership in one unit. `SuiteCatalogQueries`
reads installation rows on demand; `SuiteCatalog` owns accepted jobs and shutdown.
Interrupted external preparation changes only task progress. No original-business-fact
snapshot or file installation state is persisted. Confirmed replacement names are
temporary preparation leases, released with their job. COMMIT success is preserved
even when later view publication, projection or artifact collection fails; an old
task cannot overwrite a newer row revision or a reused request receipt.


The protected skill observer accepts only providers from the actual global/expert projections passed in each instance's environment. It reads successful skill names/providers without content, batches in bounded memory and drops failed reports without blocking or retry. The report receiver revalidates the member token after body intake, stamps current group/day, filters through effective skill ownership including experts, and limits member report frequency. These unverifiable claims remain separate from gateway records and never enter admission decisions. Administration stays private to current administrators; native member UI and capability guidance remain unchanged.

## Architecture gates

`architecture-exemptions.json` holds only the ratcheted size ledger above; no
other rule can be exempted. The lint rules cover all source and
community UI code, and each use case has a matching quick behavior test. Size
checks also cover CSS and executable test fixtures. Architecture rule samples run
in `tests/dependency-gate.spec.ts`; changing a rule requires independent review.
All community source and UI modules are covered by these gates.

## Runtime guarantees and boundaries

`PlatformProcessHost` owns platform-side container detection, hardened launch,
resource settings, private host fallback and explicit process environments.
`PlatformContainerOwner` owns scoped labels and confirmed removal. Disposable
execution and persistent shared MCP keep their protocol adapters and use this
same host; their lifetimes share `ExecutionControl` admission. Preparation uses
the disposable host's hardening and limits. Execution mounts the invoking member's
space; shared MCP accepts only readonly dependency mounts and rejects member-space
paths. This distinction follows the runtime shape and is not an administrator
option. Readonly dependency mounts preserve their absolute paths, and ordered PATH
fragments use one system-path builder. Credential envelopes enter container
bootstraps through stdin, never command-line arguments or the host CLI environment.

MCP admission rechecks durable account/token state and the current service and tool
policy after asynchronous work and before forwarding each SSE record. Grant-only
changes are checked even when service generation is unchanged. Both the admitted
and current credential masks remain applied while filtering responses. A request-local
synchronous guard captures MCP, expert and prepared-runtime policy before account
reads, then checks those same local facts inside final account registration.
Missing optional version support uses structural local snapshots. Plugin forwarding
uses the complete grant returned by final registration; its captured target, header
templates and credential must still match current configuration.

`McpServices` owns the MCP library, explicit group grants and the effective
service set used by both the gateway and member projection. New services confer
no grant, including for the protected administrator group. Explicit grants default
on. Required services override member preferences for granted
users. The same effective-service policy powers member market views, projections
and gateway admission. Durable choices are keyed by account space identity outside
the DSH profile, so environment resets preserve them. Unpublishing clears market
selections while retaining grants and their preferences; removal clears all choices.
`McpCatalogImports` owns in-flight automatic import tests; `McpServices` remains
 the sole writer of library state, adopted preset identity, progress and persistent
 import receipts. Each explicit import has one request identity. Removal retains
 its receipt to reject delayed resubmission. Preset connection fields are locked
 against the adopted configuration at the service boundary; manual rows have no
 preset identity. Only ready presets enter the effective set. Probe work runs
 outside the mutation queue and generation checks reject stale completion. Startup
 turns interrupted tests into retryable failure. Shared catalog imports wait for
 preparation through service change notifications, then discover tools through
 the existing diagnostic gateway. Generation and actor checks also guard this
 handoff. Removal and shutdown settle waiters. The 12306 preset pins its source
 archive digest and installs the author's npm lockfile with lifecycle scripts
 disabled; runtime launch does not install packages. Neither importing nor testing
 grants or publishes a service, and management responses contain no secrets.
The administrator JSON import previews standard `mcpServers` entries and confirms
each service separately through the same save validation. Suspected header,
query and environment secrets move into write-only credential slots; named slots
remain platform-side and the gateway resolves them exactly once. Stdio settings
are stored for dependency preparation; an unprepared runtime is neither projected
nor admitted by the remote gateway. Member-container settings reject platform
credentials, including credentials retained from an earlier shared configuration.
Publishing requires a successful connection test. Later connection edits or
diagnostic failures preserve publication and member choices. Library and grants
persist atomically outside user spaces. Mutations serialize
projection updates and account changes reconcile current membership. Each member
receives a separate readonly include containing gateway URLs and member-token
expressions for remote services, never the remote endpoint. Prepared member services
use the official stdio client through a platform filter. The readonly Include starts empty; its public
Loader subtree receives platform entries only after same-name personal MCP clients
yield. The member-side coordinator inspects only entry identity, service name and
disabled state through official profile composition. It appends owned disable rows
to the home patch, preserving personal definitions, explicit disable choices and
unrelated fields. Withdrawal removes only unchanged owned rows. Changes serialize
with HMR and the official profile writer lock; a busy lock releases the HMR queue
before retrying, avoiding the native manager's opposite lock order. Rename moves
grants and choices atomically, retires the old gateway name and rebuilds entries.
The official HMR queue refreshes this include;
each outer system-prompt assembly is rebuilt after the queue, with an asynchronous
recursion guard, so overlapping background refresh cannot preserve an old tool set.
`McpRuntimeDependencies` resolves member and shared MCP references through
`RuntimeDependencies`. Preparation receives only deployer egress proxy configuration;
model, MCP and member credentials never enter it. Proxy credentials are redacted
from preparation logs and are not inherited by member containers. Catalog
definitions are read-only; a tested candidate promotes its prepared version under
the stable dependency name. Superseded preparation cannot overwrite that promotion.
Legacy artifacts remain fallback-only until unified preparation and projection
succeed. Collection retains current versions and live carrier leases; startup
terminates owned stale carriers before collecting unused trees.
`McpSharedRuntime` owns one on-demand carrier per member and service, admits its
whole lifetime through the same `ExecutionControl` used by skills, and reconciles
revocation, changed settings and idle activity. Dependency or catalog replacement
drains admitted old-version requests while new connections use the replacement;
credential rotation and revocation still terminate the old process. Each carrier has an authenticated
loopback HTTP bridge to stdio, no member mounts or member environment, one readonly
set of dependency trees, and the configured CPU, memory and PID limits. Admission lasts until
the carrier is reaped. The execution timeout bounds startup and each outstanding
protocol request, not the carrier's entire lifetime. Bridge metadata reports only
request IDs and lifecycle outcomes; outstanding requests protect silent work from
idle reclamation. A timeout or cancellation terminates the carrier, so an upstream
that ignores cancellation cannot keep running outside admission. Idle reclamation,
request timeout, process exit and upstream error preserve resource teardown semantics. MCP tool-call usage is recorded at the authenticated gateway; carrier lifecycle events do not create execution-usage rows.
Shared official-client and gateway timeouts sit 30 seconds beyond the maximum
supported execution deadline, so they cannot cancel valid silent calls before
the platform deadline. Remote and member-run client limits remain separate.
Session IDs remain per carrier; expired sessions return HTTP 404 through the gateway. Shared
entries use the official stdio seam with a platform relay, which resolves the
public MCP SDK installed alongside the pinned DSH client. The relay reinitializes
once after a request receives HTTP 404 before dispatch, with a 30-second recovery
budget, then resends that rejected request once. Concurrent recovery is coalesced.
Unknown execution results and authorization failures are never replayed. Failed
recovery leaves a later request able to reconnect. Subscription loss alone does
not initialize a carrier. Only the member gateway token enters this relay; every
exchange still checks current grants and tool restrictions at the gateway. Request
IDs and cancellation references are translated together. Server requests and
notifications retain their bidirectional protocol. Startup cancellation keeps its
admission until the carrier has closed. Detected Podman always supplies isolation;
the explicit host-process fallback is labeled as development-only in management.

Member launch files contain only a service identity, generation and configuration
endpoint. The wrapper fetches the invocation into memory using the existing member
gateway token; admission rechecks current account, grants, generation and preparation.
Diagnostic fetches also require administrator access. Arguments and environment are
supplied to the child without copying them into generated launch files. Output filtering
and process-group cleanup cover both streams, including shutdown under backpressure.
The official MCP transport scrubs ambient `DSH_*` variables. Member stdio entries
therefore declare gateway URL/token expression references explicitly; resolved values
enter only the wrapper environment, never generated files or wrapper arguments.

Member preparations contain no platform credentials. The current service inputs and resolved runtime
image must match a ready preparation before an entry is projected. Completion
notifications drain independently so removal cannot wait on a projection queued
behind itself. Preparation has a writable temporary directory inside its stage,
removed before freezing, so large dependency downloads do not fill container tmpfs.

The member image includes version-pinned Debian libraries for headless Chromium.
The browser executable and MCP package are prepared separately as immutable service
dependencies; enabling a service never installs them inside a member instance.

Member MCP dependencies use the same readonly dependency root and ownership
projection as skills and administrators' direct grants. Granted or selected member
services contribute their dependency references; merely browsing a published service
does not. Declaration order defines PATH, and declared package directories supply current launchers. Live processes retain their
version leases.
The stdio wrapper resolves imported npx package commands from already prepared
packages without fetching at launch, preserves configured environment values and
member cwd, filters tools/list and rejects disabled calls. This is a usability
filter, not a security boundary: members control their own processes and can bypass
it. The wrapper owns a separate child process group and reaps descendants on normal
closure, cancellation and failure. Member diagnostics use the same frozen wrapper
inside the administrator's member instance, without enabling the service for them.

The MCP gateway checks current member identity and effective grants before forwarding
and again before releasing response headers. It shares HTTP header stripping and
streaming transport with plugin upstreams, but uses idle timeout only and forwards
the configured endpoint and locked query templates without following redirects.
Platform credentials stay outside member mounts and management replies. Each request
uses current templates and tool policy; JSON and incremental SSE list replies omit
disabled tools, and a batch containing a disabled call is rejected before forwarding.
Response values and protocol metadata mask the configured secret. Usage records include authenticated `tools/call` metadata and outcomes, never protocol discovery, arguments or outputs. Administrator discovery travels through the same authenticated gateway,
initializes an MCP session and follows tool-list pagination, then closes the session.
Its generation-checked snapshot cannot overwrite concurrent settings changes. A
failed test preserves the previous tool snapshot and records failure; UI discovery
runs on explicit test or reopening a tested service, without background polling.

`StablePublicEntry` owns the public listener across disposable business graphs. It
hands original HTTP requests and WebSocket upgrades directly to a fully activated
graph and registers each admitted socket with that graph. Database ownership loss
immediately detaches the graph; shutdown drains its work and connections before
`CommunitySupervisor` builds a fresh graph. During an outage, fresh navigation
receives a safe localized 503 diagnostic and automatically reloads; mutations and
upgrades remain closed. Configuration or key mismatches require operator recovery.
When the supervisor has classified startup failure as permanent, `GET /readyz`
returns the JSON code `platform-configuration-unavailable`, including during
maintenance. Installer readiness treats only that exact terminal signal as an
activation failure; temporary unavailability keeps its plugin preparation budget.

`CommunitySystemStatus` admits current administrators to a credential-free database
and master-key projection. PostgreSQL stores offline-backup acknowledgements by
fingerprint with the confirming account identity and database timestamp. Confirmation
locks and compares the current registry, so an old page cannot confirm a new key.
Switching databases copies these records; rotating or resetting the key leaves the
new fingerprint unconfirmed.

The default community composition wires `PostgresCommunityAccountStore`,
`CommunityOnboarding`, `CommunityAccountAdministration` and `CommunityEntry`. The platform PostgreSQL account schema
owns password hashes, the one-time bootstrap marker, the single admin flag and
retired usernames plus stable opaque space identities and persisted directory mappings. Every account belongs to one group. The account store owns ordinary groups, a single protected administrator group and the default for future accounts; role and group changes commit together. Group deletion and default changes are transactional, and account detail updates validate the email and group before committing either field. The account administration owner serializes management writes
and rechecks the admitted actor’s role and session epoch before execution.
The store protects the last enabled administrator inside a write transaction, with a shared transaction advisory lock serializing account and group mutations across database connections.
Stopping failures keep the target account disabled and visible for retry; deletion
retires the space only after confirmed termination and leaves its directory intact. Reused
usernames receive a new space, session binding and model access token. Account storage retains durable directory mappings and optional email. Sessions bind cookies
to both username and space ID.

`PluginLibrary` owns durable plugin additions, exact npm identities, administrator
admission, progress, retry and shutdown. Library mutations, background preparation writes, catalog fact transactions and `PluginMarket` publication share one package-keyed operation owner supplied by composition; publication cannot write a stale row over another completed edit. `PostgresPluginLibraryStore` reads library rows on demand and records current/replacement upload references in the same transaction. `PluginLibraryCatalog` owns catalog staging; `PluginLibraryAdministration` owns administrator edits. Both share the library package queue. Plugin removal is one use-case unit of work: the parent deletion cascades to grants, preinstalls, receipts, selections, local-copy preferences, access settings and upstreams. Successful native delivery history remains until its account is deleted. No removal intent or startup removal recovery is needed. Failed additions have no current
version and are not published. `ContainerPluginPreparer` uses disposable rootless
containers with no member mounts or platform credentials. It verifies registry
sha512, installs through the official DSH CLI with lifecycle scripts disabled,
checks every dependency declaration and prepares runtime peers. Actual activation
is checked through the native plugin inventory in a network-disabled container
with read-only artifacts. Original archives and prepared dependencies are published
by content hash only after successful offline startup. Package patches are preserved verbatim and converted to protected includes before the offline boot. Conversion retains ordered group insertions and lazy expressions, resolves modules inside the preparation container, and rejects unsupported or platform-targeting overrides. Shutdown awaits all preparation tasks; failed container
removal retains staging and blocks further preparation until ownership-checked
startup recovery succeeds. `FilePluginUpload` streams at most 50 MB into private
incoming storage and hashes the original bytes. A read-only, network-disabled
container reads the archive manifest; the host never extracts or executes uploaded
content. Accepted originals remain available for retry, duplicate uploads discard
their incoming copy, and the same version with different content is rejected.
Intake cancellation removes incomplete files after container exit is confirmed.
`NativePluginDownloads` binds short-lived retained-archive access to the current member, space, session epoch and checked artifact. The private gateway terminates only the synthetic archive destination before ordinary HTTP/CONNECT forwarding; it rechecks eligibility after opening the archive. `MemberNativePlugins` refuses to replace an existing native copy. Its native manager downloads and verifies the main archive inside the member container, retains it under the web profile, then supplies that local path to the official install RPC. The call uses the platform npm registry for transitive dependencies without changing the member’s saved registry or approving build scripts. Removal calls the official native bundle RPC independently of the library shelf.
Replacement preparation has separate durable candidate state; the checked current
version remains selected until an administrator confirms the fresh group/member
impact. Known version integrities survive replacement, preventing changed uploads
from reusing an earlier version identity. Removal first persists an unpublished
removal intent, which excludes the package from selection and distribution, then
clears all grants and deletes the library row. Startup resumes interrupted removals
before accepting requests. Immutable artifacts remain available to running mounts.
`PluginCompatibility` gates startup on checks for the platform-version/runtime pair.
It reuses retained original bytes, rechecks current and candidate versions, and
persists publication intent before asynchronous work. Incompatible plugins retain
grants and their previous artifact, but leave managed selection and the market.
Selecting a compatible replacement restores intended publication; administrators
can cancel that intent. Each successful check receives an immutable preparation ID,
so the mounted directory is the exact tree that passed activation even when the
DSH revision is unchanged. Shutdown cancels and waits for upgrade checks, and
container cleanup or persistence failure remains a startup failure. Installed
readiness budgets include current/candidate checks; an exited service fails early.
Environment reset removes member profile copies and yield entries, while the
platform library, artifacts and grants remain outside the reset carriers.

Library recovery removes abandoned intake files and unreferenced original archives after owned-container recovery, preserving originals referenced by durable additions.

`MemberManagedPlugins` is the only effective-selection port consulted by instance
startup. It selects the union of compatible current artifacts from explicit group
grants and published member choices whose plugin has a platform upstream credential, with the same policy for administrator groups.
`PostgresPluginSelections` stores those choices by durable space identity outside member
profiles. Unpublishing clears choices after confirming the current selected-member
count; recovery clears stale unpublished choices while retaining compatibility pauses.
Removal clears choices and both group lists while preserving native copies and delivery
history. Environment reset preserves read-only choices and group lists. `PostgresPluginGrants`
persists controlled grants and preinstalls atomically; group deletion clears them and
startup removes retired-group keys.
New grants require a prepared compatible artifact; existing incompatible grants remain
recorded. `ManagedPluginAdministration` projects pending changes by comparing the
running instance's startup snapshot with the current selection and reuses member
restart actions only for affected running accounts. No background restart is scheduled.
Each launch mounts only selected prepared artifacts and its generated include files
read-only. The runtime driver records skipped artifacts and native activation failures
on the instance; a single bounded, cancellable token/inventory probe owns its requests.
Management views expose a typed summary, not arbitrary plugin diagnostics. After the prior carrier stops,
startup reads the selected self-installed bundles through confined, bounded profile
files and asks the effective-selection policy for yielding targets. Appended
name-qualified disable rows carry their original identity in YAML comments; the
member's prior rows and installed files remain intact. Revocation removes only
unchanged owned rows; edited rows retain the member's values and lose the ownership
marker. Lazy expressions are parsed without evaluation. Marketplace actions install ordinary plugins through the checked native archive seam.
`MemberNativePluginJobs` owns accepted request IDs, per-member/package exclusion,
real download/install phases, safe failures and shutdown draining. Closing a panel
stops observation, not the operation. `PostgresPluginInstallations` keeps successful
delivery source and version by immutable member space plus package; native removal,
upgrade and disabling do not rewrite history. Cards read the actual native inventory:
a current dependency on a retained platform archive can be removed here, while an
independent native copy is preserved. Missing source metadata remains independent;
no durable history is used to infer the current copy or its version.
Credential-bearing market choices retain readonly loading; explicit group grants
remain readonly regardless of credentials. Those cards alone show the shared KEY
and controlled labels. Native copies carry no source label. Pending changes link to
the existing confirmed restart; an accepted native result never restarts an instance.
A maintainer's local-copy preference applies only to a current readonly acquisition,
and a stale preference cannot suppress ordinary native loading.


`GroupPluginPreinstalls` captures the available current artifacts and member identity for
one startup. `MemberPluginPreinstalls` dispatches that plan once after the lifecycle
registers the ready carrier, without awaiting installation or recursively ensuring the
instance. Each package revalidates the member, group, artifact and carrier; failures
write no history and retry only on a later carrier. Distinct incomplete-member counts
belong to this owner, not configuration revisions. Native jobs share the same member/package
lock for manual and preinstall operations, with separate internal request identities.
`preinstall-plugin-coordination` reads confined prepared patches and adds future owned
yield rows only for packages actually projected read-only globally or into a successful
expert preset. The native copy can therefore be installed once while existing read-only
eligibility keeps priority. Releasing ownership preserves explicit member disablement.
Environment recovery cancels and drains both job sources after stopping the old carrier.
Only successful backup and reset clear preinstall-source history before replacement
startup; selected-source history remains and does not cause automatic restoration.


`PluginAccessAdministration` owns validation and upstream-reference discovery. Its
PostgreSQL store keeps per-package environment templates and entry configuration with
an immutable revision per change. YAML is parsed without evaluating tags; only
prechecked owned leaf entries can be configured. Reserved runtime variables and
cross-plugin environment conflicts are rejected before saving. `MemberPluginAccess`
projects effective readonly plugins into member-token environment and entry overrides.
Environment values, the whole YAML document and parsed string leaves are encrypted,
including suite rollback snapshots. Management returns configured/last-four summaries;
blank values retain saved data and YAML clearing is explicit. Trusted projection creates
reserved environment references for every entry string, so generated files contain no
resolved access values. Native environment snapshots retain a digest of effective values.
Successful native deliveries still present in the startup profile inventory receive
only ordinary literal process environment: reserved names and credential/upstream
templates are excluded, and native entry configuration is never projected. Native
environment snapshots track changes to those literal values independently of entry revisions;
retained delivery history alone cannot inject environment after uninstallation. The DSH access seam applies object merges to generated per-start
includes while leaving immutable artifacts intact. Instance snapshots include
access revisions; upstream credential or address edits do not require a restart.
Platform credentials remain solely in the upstream store and are never part of this
projection. Publishing a credential-bearing upstream requires explicit confirmation.
The local DSH credential store resolves a saved reference before the launch
environment, then project and home `.env` files. Platform access variables override
launch variables, but cannot override a saved credential reference. A member's
same-name saved value can therefore stop platform routing; removing that reference
restores the launch value. Personal credential storage stays under member control;
actual platform secrets remain outside the user space.

`CommunityEntry` supplies the current account's `/app/<spaceId>/` mount.
HTTP and upgrade intake authenticate and compare that mount before stripping
the prefix or starting a runtime. Login exchange and proxy responses scope DSH
cookies to the mount and add Secure under HTTPS. Runtime launch uses the official
WebServer index tap to make manifest requests carry credentials, and the official
`--public-url` seam for the browser origin and mount, while the readiness token
exchange and shared model gateway use private loopback listeners. A displayed
HTTPS URL never changes those private transports into public model endpoints.
Public account facts and community management DTOs exclude credentials and private state. The community entry is the sole product composition. Deployment configuration retains
`DSH_PHALANX_REGISTRATION_ENABLED`, defaulting to `false`. Open registration is unsupported: `true` is rejected during configuration validation and public registration
URLs remain closed.
`CommunityInstanceActions` checks the admitted member’s fresh space identity and session epoch and coalesces concurrent restart requests. `/recovery` is served by the platform without entering DSH; its restart exchanges new native cookies only after successful startup. The protected include in `dsh/community-platform-plugin.ts` owns the two native action entries and manifest credential configuration.

`CommunityInstanceLifecycle` owns per-user admission, pending starts, liveness
replacement, serialized restart/termination maintenance, activity fences and shutdown through `CommunityRuntimeDriverPort`. Its automatic-start queue admits at most two starts; foreground entry promotes and joins a queued attempt. Maintenance and shutdown cancel queued work before waiting for active starts.
`ResidentInstances` owns stable-space eligibility and timestamped automatic failures. It scans after startup readiness and confirmed health retirement, and both queue admission and completion recheck the global upgrade maintenance gate; failures suppress automatic retry until a successful member start or an explicit eligibility change. Disabled members retain their persisted flag; deleted spaces are pruned. `InstanceResources` owns revisioned idle/resident/resource settings in PostgreSQL. One shared revision protects defaults, idle settings and independent per-space override/resident rows; account deletion cascades those rows and advances the revision even when the account had no override. Administrator and target identity are checked inside the same unit of work as each settings write. New resource settings start unlimited; only the deployment idle input initializes an absent settings row; ordinary reads await SQL without a process cache. Capacity guidance counts the union of running and enabled resident spaces. Idle reclamation rechecks current seconds, residency and activity across asynchronous probes; operator reclamation retains its separate intent.
`CommunityRuntimeDriver` owns process/Podman I/O and handles keyed by exact instance
identity. Registered instances bypass runtime queries on entry. The idle sweep also runs
a batched carrier check every 30 seconds, even when idle reclamation is disabled.
Connection refusal, reset and truncated upstream responses query the exact failed
instance once without replaying the transfer; a late check cannot retire a replacement.
The reverse proxy reuses HTTP connections through an application-owned keep-alive agent.
Account authorization reads use the shared PostgreSQL database without request account caches.
Account storage ports return Promises. Final connection registration uses
a short PostgreSQL row-lock transaction: a fresh account read and a synchronous,
reversible registration share that fence. Registration or commit failure unwinds
registered cleanup callbacks in reverse order. HTTP success bytes follow commit and
a local closed-handle check. DNS, instance startup, upstream connections and stream
lifetimes stay outside the account transaction. Preview revocation remains synchronous
for local connections; asynchronous sweeps are observed and drained before storage closes.
Storage mount identity has a 250 ms cache; directory ownership and the private
storage marker are still checked on every entry, and failures invalidate the cache. `ports/clock.ts` defines the clock;
`adapters/system-clock.ts` owns the real clock used by idle reclamation.
Startup deliberately rebuilds containers matching community plus data-root labels;
it never removes user files. `OwnedCommunityContainers` owns that carrier inventory and removal.
`PostgresContainerHostnames` retains the first hostname for each stable space with an account foreign key.
Launch adds the stable space label. Rebuild may remember a hostname only when both username and space labels still identify the current account;
legacy carriers without a space label are removed without adopting their hostname. Offline carrier cleanup needs no database.
Account deletion cascades the hostname, so a recreated username receives a new machine identity; replacements of the same space retain it.
Rootless
identity and launch flags remain owned by `dsh/container.ts`. Container mode uses
a separate loopback model listener and closes the public model route.
`CommunityModelAuthorization` captures one admission and compares account/token versions
after intake and response headers, reauthorizing only after a change. The model gateway
parses the Messages body once; the upstream transport serializes the routed object once. `FileCommunityModelAccess` owns protected durable opaque per-space
tokens. `FileSharedModelStore` owns private shared-provider state and public configuration publication. `SharedModelAdministration` checks administrator authority, revision and default supply. `SharedCommunityModelUpstream` captures the selected provider at admission and injects its key only at the outgoing Messages transport. Shared catalogs contain opaque model identities and provider labels, without upstream keys. `CommunityWebToolsGateway` authenticates the member token, forwards only the documented Search or Fetch fields, rechecks current identity after upstream response headers, bounds request and response size and one 60-second call, rejects redirects, and keeps no response cache. Its usage metadata goes through `UsagePolicy`. `SharedCommunityWebToolsUpstream` chooses one enabled shared provider whose base URL host is `api.deepseek.com` — the default model's provider first, then the first such provider — and injects its key only at the outgoing retrieval transport; with no such provider the gateway returns an explicit administrator-facing explanation. A provider proxying another host supplies no retrieval credential. Container mode closes the public retrieval routes and serves them only through the private member gateway, like the model route.

`PluginUpstreamAdministration` owns administrator-only upstream settings and redacts
credential values in every management projection. `PostgresPluginUpstreams` reads package configuration on demand and protects credentials, headers and diagnostic requests with field-bound envelopes. `PostgresPluginAccessStore` likewise reads on demand and updates changed protected fields by key. `PluginUpstreamAccess`
rechecks opaque member tokens, current account/space, compatible library state and
fresh group or publication eligibility for every request. `NodePluginUpstreamTransport`
owns direct host HTTP(S), strips member authentication and hop headers, injects the
saved templates, streams at most 64 MiB of request bytes and applies 600-second
response-header and idle deadlines. Redirects and upstream errors pass through;
upstream cookies do not. The plugin gateway shares the private listener and session
cancellation boundary; process development exposes it like the model gateway.

The community gateway keeps cancellation and backpressure at the shared streaming
boundary and keeps that credential outside user spaces. The composition connects proxy errors to the existing HTTP/WebSocket failure handler.

`CommunityNetworkAccess` authorizes fresh per-user tokens and pins public IPv4
DNS results through an injected resolver. `NodeNetworkResolver` owns DNS and
host-interface/configured-public-origin facts and the explicitly declared complete
public IPv4 host inventory; missing inventory fails external access closed. `NodeNetworkTransport` owns pinned
TCP/HTTP I/O with a connection/header deadline and no platform-imposed idle deadline
once connected. The authenticated HTTP/CONNECT handler shares the private gateway,
and tracked connections close with account revocation. Container proxy variables
point to that gateway while pasta keeps direct outbound access confined. Native
settings and plugin installation use the user's writable profile. Host initialization
rejects linked profile directories and patches before reading them; the prior carrier
is removed and startup is serialized, so native processes cannot race those checks.
A damaged profile fails entry with a repairable 503. Missing default
legacy model rows remain in the writable profile for upgrade compatibility. The final managed include disables ordinary native provider settings and supplies shared models through the exported generic adapter. Its public catalog and watcher are mounted read-only in containers; HMR updates volatile adapter/default configuration and announces directory changes. Members retain unrelated settings, terminals and their own plugins.

The rootless container is the integrity boundary for each user's private home,
workspace and configuration. Process mode is development and diagnostic mode
and makes no isolation promise. Instance ownership lives in memory; restart
recovery rebuilds owned containers from durable account identity and data-root
labels, preserving private files and native settings. Profiles remain private to each user.

Developer setup and target-specific verification are in [the contribution guide](../CONTRIBUTING.md).

`FileCommunityUserSpaces` resolves the current account-to-directory mapping through its account reader and owns private home/workspace preparation.
`UserStorageGuard` reads platform-wide owner and binding rows through `UserStorageFacts` after database initialization and on each availability check; it keeps no SQL fact cache.
A stable SQL owner precedes external marker creation, followed by a compare-and-swap binding publication. A missing SQL owner never adopts an existing volume marker.
Canonical root separation, mount identity, private ownership and marker checks remain filesystem responsibilities in `user-storage-files.ts`.
Only physical mount inspection has the documented 250 ms cache. Entry and new carrier startup await availability before accessing a space.
Omitted default storage remains distinct from an explicit external volume; omitting a previously bound volume fails closed.
Default durable storage is `resolve(dataRoot) + ".durable"`, with `users` and built-in `postgres` as siblings below it; and retired username reuse uses the reserved `_spaces/<spaceId>` namespace under the user root.
External storage changes require explicit migration.

`CommunityEnvironmentRecovery` authorizes a current administrator or the current member resetting their own stable space. A synchronous per-space promise registration precedes asynchronous admission, preserving the first initiator for joined requests. A short unit of work locks fresh actor and target account rows, checks the persisted cooldown and writes the latest initiation before side effects. History is keyed by stable space and cascades on account deletion; the initiator username remains historical credit. Identity is rechecked through stop/backup/reset/start; member requests have a ten-minute window that survives restart, while administrator requests preserve that member window and remain exempt. The history records initiation. The lifecycle's separate `recover` operation prevents a pending restart from skipping preparation. `FileCommunityEnvironment` copies only official web-profile/home configuration carriers into private `<userDataRoot>/_environment-backups/<spaceId>/` backups on the user-space volume after carrier removal; links are copied as links and special files fail closed. Complete manifests describe present and absent carriers for manual restoration. After publication, retention keeps the current copy and two newest verified copies in that exact platform space; unknown/incomplete/linked directories are preserved and cleanup failures only log. Backup manifests use a stable user-root-relative home so volume copying preserves scope and retention; restoration instructions resolve the current configured user root. Manifests without a completion timestamp use their final write time. Home, workspace and sessions remain intact. Only administrator responses contain backup locations and restoration instructions; self-service success and failure responses exclude them. The standalone recovery page requires no management or native plugin assets.

`CommunityUserStorageMigration` orders offline maintenance, copying, verification and publication through its port, with an explicit rollback operation.
`FileCommunityUserStorageMigration` acquires the platform file lock before opening the protected database owner and production session; its finally path closes both.
Private pending/verified/complete/rolled-back receipts live beside the database configuration in `storage-migrations/`, retaining the source, previous binding and revision.
`UserStorageBindingMigration` validates the physical target, publishes its marker and then compares-and-swaps the SQL binding.
`user-storage-copy.ts` owns link-preserving copying and independent byte/type/mode verification; only verified data receives the new binding.
A verified marker after rename resumes only SQL publication, including when the SQL commit succeeded but the complete receipt was not saved.
Completed retries validate the target without copying over later destination changes. Rollback validates the retained source and restores the previous binding only at the recorded revision; it copies or deletes neither tree and rejects later storage changes.
The operator explicitly updates or restores the protected environment afterward; mismatched or unavailable storage fails closed.

`SkillLibrary` serializes reviewed ZIP changes, publication, selections and recovery.
`SkillMembership` combines group grants with published member selections; managed
access wins. Administrator groups use the same explicit grants as ordinary groups.
`FileSkillArtifacts` validates and stores immutable content outside member spaces.
`FileSkillDistribution` atomically switches a relative live link inside each member's
stable read-only mount, then removes obsolete generations. A separate official
skill-filesystem provider includes that directory without changing member default
roots. New sessions discover changes without an instance restart; ongoing tasks
have no old-generation guarantee. `FileMemberSkillNames` reads only top-level names
through no-follow directory descriptors to report member overrides. It does not
parse or execute member skill files. Startup recalculates bundled-name conflicts
and reconciles saved desired state before serving HTTP. Reset excludes skills;
disabled accounts have no projection, and deletion also clears selections.
`SkillPacks` owns pack edits and removal impact; effective access unions direct
and pack grants/selections. Packs reference library skills and may own a generated
orchestration note. `SkillLibraryImports` prepares immutable content before committing selected skills,
packs and removals through one `PlatformUnitOfWork`. `SkillLibraryCatalog` shares
the same mutation queue and artifact retention boundary. PostgreSQL foreign keys
cascade deleted skill references and carry all pack references across a rename.
Failed transactions leave facts unchanged; unregistered artifacts are collected.
There are no persisted import or pack-removal intents. Projection failure after
commit retains facts and permits synchronization retry. ZIP and Git input share
the same review path.
`GitSkillRepository` owns bounded anonymous HTTPS cloning, ref resolution, process
supervision and temporary cleanup. Pinned revisions are fetched directly; a selected
subpath uses a filtered fetch and literal sparse checkout so unrelated repository
blobs are not imported. Git objects and expanded source each retain the import
size limit without counting the same content twice. Provenance records the resolved
commit and per-skill content identity. No imported script, hook or submodule is executed.

`SkillExecutionOwners` adapts effective skill access into opaque execution owners.
`ExecutionAdministration` owns reviewed commands, blocked first arguments and
write-only secrets. `ExecutionDependencies` resolves shared runtime dependencies,
leases active calls and retains private artifacts only as migration fallbacks.
Migrated dependencies seed their preparation from the approved skill source;
updated contributions must receive execution approval before that source is rebuilt.
The runner executes migrated relative scripts from the prepared source tree so
local modules resolve correctly. `RuntimeDependencies` owns credential-free
preparation, usable-version selection and leases; active preparation seeds and
execution sources are protected from skill collection. Shutdown waits for calls
and final collection. Failed container cleanup prevents artifact reclamation until
recovery verifies termination. MCP preparation uses this same credential-free owner;
old private preparation stores are read only by the migration fallback adapter.

The platform plugin registers member gateway access through the official DSH
`shellEnv` per-call contributor. This restores the two member gateway variables
after native-shell environment filtering; platform credential variables are never
registered or exposed to that shell.

`PlatformExecution` rechecks current owner access and configuration at admission.
`ExecutionControl` owns resource limits and cancellation. `PlatformExecution` reports each admitted or refused execution through `UsagePolicy`. Forwarders
carry opaque owner and command identities through an authenticated NDJSON route;
no platform secrets or member environment are copied into the projection/request.
`ContainerExecutionRunner` invokes immutable commands in fresh rootless containers
with only that member's space and configured variables. The command's output remains
unchanged. No TTY or interactive prompt is supported. Development fallback requires
an absent Podman executable and no configured container, and provides no isolation.

`ServicePreview` owns temporary application authorization, bounded login revocations,
live connection registrations, bounded random preview leases and trusted gesture timestamps. A separate same-host
origin/port carries only an admitted container loopback service; its gateway strips
platform credentials and enforces opaque sandbox/CSP response policy. The trusted
wrapper mints a capability bound to the original login, space, port and exact instance.
Opaque resource requests use that scoped bearer capability without ambient platform
cookies. Shared browser storage is unavailable; the credential-bearing internal
preview path must remain private. Address-bar wrapper links contain no capability. The platform origin
independently rejects foreign-origin HTTP and WebSocket access. A trusted outer page
reports real visible interaction; preview HTTP traffic and idle WebSockets never
register as native persistent activity. Account epochs and exact instance identity
are checked synchronously before upgrade admission and periodically for live streams.
Preview lifecycle changes do not cancel accepted native agent tasks.

## Key decisions

**Independent community codebase.** This repository owns its source history, release inputs and supported interfaces. DSH stays external and pinned, with one owner per official seam. Independent evolution keeps changes reviewable without a shared-core or feature-matrix prerequisite; source drift and deliberate manual integration are accepted costs.

**Rootless user spaces.** Installed deployments run one rootless Podman user instance per account, with private home/workspace mounts and loopback listeners. The authenticated network return path pins public IPv4 destinations and rejects declared host aliases; missing inventory fails closed. Development mode offers no isolation. Rootless operation requires Linux host preparation and real container/network verification; it does not certify arbitrary plugins.

**Administrator-owned shared models.** Administrators own provider credentials, manual model lists and the default selection. Stable opaque identities route Anthropic Messages requests using a provider snapshot captured at admission; disabled selections fail without silent fallback. Catalogs update through official DSH seams, while keys remain in platform storage. Ordinary personal-provider settings are unavailable; terminals, user plugins and unrelated settings remain available, including external model access through user code. The gateway is not a prohibition on all external model traffic. Administrator model lists declare each model's input types as text or text and images; the platform writes that declaration into the DSH model entry, which enforces it at session admission, `read_image` and subagent image delivery. The platform does not infer capability from provider metadata.

**Stable authenticated user-space entry.** Each account has a durable `/app/<spaceId>/` path; the ID grants no authority. Every HTTP request and WebSocket upgrade checks the current account and space before forwarding. DSH cookies are scoped to the admitted mount, with Secure under HTTPS. The public URL and index tap use official seams, preserving native query/hash bookmarks; the cost is explicit proxy and cookie ownership rather than modifying DSH routing.

**Independent platform pages.** Login, first-administrator initialization and instance recovery are lightweight server-rendered pages independent of management bundles and native DSH. Shared appearance is applied before paint. Authentication, expiration and recovery authority remain server responsibilities; credentials stay in the fragment/form and are not retained in display preferences. The platform must still run: this is not offline login. A small shared renderer is maintained to keep recovery available when larger applications fail.

## System update transaction

The system update is a fixed combination of platform, management UI and DSH
image. Preparation keeps the old service running. Application immediately closes
work admission and stops the platform and its owned user instances. There is no
idle-task waiting, countdown or historical downgrade operation.

Release manifest schema 2 declares a compatibility protocol, a source version interval, account
schema source range and target, and a user-environment epoch. The Linux platform,
DSH revision, source commit, platform checksum and image digest remain mandatory.
An optional `compatibility.freshInstallThrough` boundary refuses older deployments
before invoking their platform CLI, including during executor bootstrap. The
source schema range also excludes the legacy schema so already installed
executors fail closed even when they do not recognize the new declaration.
Current checks return typed fresh-install guidance; older pages retain their
existing incompatibility presentation and release-note text.
The updater reads registered schema versions through the verified installed
release's read-only CLI. Sources predating registry reporting expose only the
core schema through `database-wait`. A bounded subprocess finishes before the
Web transport deadline; invalid output or connection failure produces an
operator diagnostic. The platform process mutex and installation lock retain
separate responsibilities. A database archive tool inherits the installation
lease until its Podman invocation actually exits, including cancellation or
loss of the calling process.

An optional root `imageIdentity` extension separates image build inputs from the
platform commit. When present, installation, prepare, recovery, bootstrap source
verification and cleanup check the image digest, input-hash label, DSH revision,
architecture, non-root user and declared runtime command. The build commit is
provenance only. Without the extension, the image revision label must still equal
the platform commit. A malformed extension is rejected; it never falls back to
legacy verification. Shared-image cleanup retains every image referenced by the
current or previous successful release, in addition to container references.
Image selection is recorded separately from platform identity. Reuse requires
compatible baseline updaters and an exact input-hash registry lookup; manual
rebuilds remain possible. Rehearsal selections cannot enter formal promotion.
Explicit candidate rehearsal may admit the same target version only between
distinct marked run-ID candidates sharing image identity and unchanged account
schema; formal sources and ordinary CLI/Web updates keep the version interval.
An already present verified digest needs no pull/import or additional image
capacity during upgrade, including restoration after failed activation.
Protocol 1 requires identical DSH revision and environment epoch. Protocol 2 and
capacity-aware protocol 3 additionally admit explicitly listed immutable source DSH revisions, while still
requiring an identical environment epoch. Its runtime transitions retain the
existing member file format; they never run member instances before the durable
commit and do not authorize a user-space migration. Existing protocol-1 executors
reject protocol 2, and older protocol-3 executors reject its runtime-transition extension. The target installer or bootstrapped updater owns such prepare/apply transitions. A release that
changes delayed per-space migration must change its epoch; this protocol refuses
it before cutover. Existing pending legacy first-entry preparation is unchanged.
Other DSH or environment changes need a reviewed migration protocol.
Only explicitly supported legacy manifest formats can enter the new protocol using the new installer; see the target release notes for one-time upgrade steps. An undeclared legacy
upgrade cannot use link-only rollback.

Owned cleanup runs before protocol-3 download capacity measurement and after
commit and reopened admission. It has independent durable status and retry under
the same installation mutex. Cleanup failure cannot enter update recovery or
change a successful update phase. The root owner verifies historical receipts,
current/previous successful identities, prepared/interrupted references, all
container image and bind-mount references, and active program use before each
removal. Unknown ownership, data and recovery executors are retained. Verified
historical backups are reclaimed except for the journal's current operation.
New backup lifecycles durably record their ownership before copying, then release
their own complete or partial backup after success or restoration through a
persisted cleanup intent. Interrupted cleanup retries accept an already removed
backup. Legacy completed operations without this lifecycle keep their current
backup; failed recovery always retains its backup and closed admission.
Image deletion never forces or globally prunes. Observed filesystem release is
bounded by removed candidate inode allocation, accounting for shared layers and
hard links rather than summing declared image sizes.

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

The backup contains mutable platform-root carriers except reserved member
`users` and the transient platform lock. Configuration, install receipt,
manifest, keys and platform/database service units are separate carriers,
including their absence. It copies links as links, rejects special files and
records bytes, types, modes and ownership. Files are read once while copying and
hashing, followed by one synchronization of the completed snapshot. Switching
does not reread the snapshot; recovery verifies it before changing live carriers.
Rebuildable paths come from the installed source package's `dataRootLayout`
artifacts, projections and runtime categories. They remain in place, with their
existing directory inventory recorded in the new receipt format; a missing tree
refuses restoration before mutable data is replaced. Legacy receipts restore
their original complete snapshot semantics. After the old platform and its owned
containers stop, the exclusive platform lock establishes quiescence. Member
homes, projects and external user volumes are excluded; validation checks their
existing binding without creating directories or markers, and admits no member
or resident instances before commit.

Registered PostgreSQL schemas are exported as a private custom archive. Tool
facts and export estimates are read before filesystem capacity is checked. Only
after that check can preparation obtain a verified image matching the server major;
backup and restore use that immutable identity without pulling. The embedded
executor program is generated from the platform adapters and uses the verified
source package's connection/key owners. Decrypted credentials remain in memory
or private temporary files, never command arguments, environment values or
receipts. Only built-in PostgreSQL is started independently after platform stop.
Recovery restores keys, connection configuration, database unit and old release
link before restoring the database and starting the old platform.

Database recovery clears registered content with RESTRICT and imports within
one transaction under deployment/migration locks. Existing namespaces retain
their identity, owner and grants, so schema ownership does not require database
CREATE privilege. Only namespaces absent before the upgrade are removed.
External dependencies or changed namespace metadata refuse recovery rather than
remove unrelated objects. A failed recovery retains the verified archive and
keeps admission closed.

Maintenance uses one live admission fact to prevent artifact reclamation at its
filesystem owners, including Git intake, plugin/contribution carriers, skill and
dependency projections, execution trees and private Python environments. Existing
container-use barriers remain in force, and container shutdown/recovery still runs.
Retained dependency identities are still returned while collection is deferred.
New publication staging may be cleaned without reclaiming older trees. An
existing platform YAML parser with a mismatched manifest is refused during
maintenance before replacement; normal startup can repair it, and an absent parser
can be published without removing an older tree.

A narrowly scoped nftables table fences the managed TCP listeners (including an enabled preview listener) independently
of application version. Explicitly marked root readiness probes retain access.
Only the primary HTTP endpoint can additionally serve a maintenance page from a
verified listener socket cgroup. PID1 first pins that exclusive socket in an
operation-owned descriptor store. Only a new SYN matching the exact cgroup can
receive that listener's connection token; descendant and unrelated cgroups are
excluded. The token permits subsequent handshake packets that do not yet have a
full socket. Every new SYN clears an old page token, and closing admission removes
all token continuation rules.
Gateway and preview endpoints keep the marked-probe fence. The updater never
flushes or adopts unrelated firewall tables.
Atomic carriers and their parent directories are synchronized before effects.
An independent root boot unit reinstates admission from the marker or active
journal before the exact
managed user service starts. A failed fence or verification stops the service and
owned containers. Extreme shutdown failure is reported as unverified admission.
The bilingual standalone pages are rendered during the service build and included
in the platform package. A transaction-owned transient root service reads only
the installed source release's pages while the platform is stopped; a source
without these files retains connection reset. Its journaled unit, command, page
hashes, cgroup and listener identity are checked before reuse or shutdown.
The root services preserve their descriptor stores across process failures;
the updater checks the stored name, socket inode, endpoint and exclusive binding
before granting access. Thus a crashed serving process cannot leave the port
available for an unrelated listener. No shared socket is shut down by its keeper.
Before every normal or recovery start, the updater withdraws the page exception
and stops that service, resets a failed unit when necessary, and explicitly
releases its descriptor store before the platform binds. During validation it confirms the selected
packaged process, maintenance configuration and exact managed service cgroup
and pins its exact existing listener before exposing the target's maintenance
page, without waiting for full readiness. Commit releases the keeper's references
before opening business admission; the running platform retains its own socket.
Boot admission restores a closed fence rather than a previous page exception.
The root-owned maintenance marker additionally blocks business HTTP, model/network and WebSocket
admission during validation. `/healthz` remains liveness; `/readyz` reports completed
startup. The updater additionally verifies the service MainPID owns its listener,
executes the exact selected bundled Node and release directory, and matches the
platform and image identities. A displayed URL does not prove external access.

The installation boundary remains Ubuntu 24.04 amd64 with rootless Podman. The
independent executor and administrator UI use this same transaction; they do not
receive a general privileged shell or choose arbitrary deployment paths.

The root executor runs in `dsh-phalanx-updater.service`, outside the non-root
platform's user service and cgroup. Its Unix HTTP control socket admits only root
and the canonical platform UID using kernel peer credentials. A closed JSON
grammar accepts status, channel-aware release check, prepare, exact-operation apply and
recovery. It accepts no command, URL, credential or deployment path. Candidate run
identities are admitted only from a candidate deployment; formal identities remain
available to both channels. The root installer receipt owns the canonical channel
and source address independently of PostgreSQL. Same-version candidate-to-formal
conversion uses the full transaction and commits the channel with the receipt.
Candidate discovery reads a fixed public metadata pointer, then verifies the exact
run manifest and publication proof. Publication updates this pointer after complete
assets; compare-and-swap preserves newer concurrent publications during cleanup. The same file lock excludes CLI and
executor mutations; an accepted UUID is persisted before background work.
Application submission records `stopping` and closes admission before replying.
Browser disconnect and platform shutdown do not cancel the worker. Executor
restart recovers the durable operation instead of submitting another switch.

Each verified platform includes an executor inventory bound to its source commit.
Root installation copies it into an immutable, synchronized bank, then atomically
publishes its pointer. Old banks remain available. The backup includes the prior
executor pointer, unit and boot-admission program/order; commit installs the target
executor, and restoration returns the old carriers. After a terminal result and
lock release, systemd replaces the executor if its bank changed. A corrupt bank
can be repaired only from an already selected release package matching the
recorded inventory; otherwise maintenance stays closed with CLI recovery guidance.
Public status exposes bounded sanitized events and release identities, never the
protected configuration or backup content.

Catalog updates keep the active service and a private candidate in the same MCP
store transaction. `McpServices` owns activation and checks the originating actor
and base generation before accepting discovery. Candidates use reserved internal
names for administrator-only discovery, never member projection or grants.
Preparation inventories include both active and candidate inputs; a promoted
service retains the candidate preparation identity to avoid reinstalling a tested
artifact. Existing carrier leases protect old dependencies until reconciliation
has stopped their readers. Restart interrupts candidate work and preserves the
active service; an explicit retry has a new durable operation identity.

Capacity-aware upgrade protocol 3 binds storage estimates and a small updater
inventory to the selected release. `installer_storage.py` groups peak writes by
actual filesystem, including Podman image-copy staging, and fails closed before
download or stop. The public bootstrap path validates exact-commit module hashes
and replaces only the root updater bank; the current platform stays running.
Legacy executors reject this protocol before acquiring platform archives.

Expert conversation models: the platform App Center creates a new session with the
expert preset, selects its currently enabled shared model, then opens that session.
Members can change models with the native model picker. An unavailable expert model
is flagged in the expert library and leaves new sessions on the host default.
The pinned DSH preset schema has no model field: choosing an expert in the native
mode list follows the host's model rules and does not apply the expert model.

Expert definitions, grants and summons live outside member profiles and survive
environment resets. Library views identify unavailable saved references; editors
can remove them or retain them while repairing other fields. The member App Center
also reports partial capability loss. Each expert-local plugin or MCP service uses
the protected preset loader: failed children finish teardown before preset audit,
while surviving tools remain available. Diagnostics contain entry identities.

Expert edits take effect on instance restart. Active conversations keep the old
definition before that restart; restored conversations and new conversations use
the current definition afterward. Stable preset IDs preserve history and allow a
dismissed expert's conversations to resume after it is summoned again. Deletion
previews current holders and groups, checks that impact again on confirmation,
and removes grants and summons. Its exclusive gateway access ends immediately;
loaded definitions disappear after restart and conversation history remains.


### Rebuildable data root

`domain/data-root-layout.ts` is the single inventory of allowed artifact, projection and transient runtime paths. `inspectDataRoot` checks populated installations against those exact subroots and refuses unknown siblings or redirected roots. Durable PostgreSQL data and default user spaces live in the separate per-deployment `.durable` namespace; explicit user volumes retain their configured location. Master keys and operator recovery receipts stay beside the protected database configuration. Deleting projections preserves those durable stores and all immutable artifacts. Current execution consumes independently prepared runtime dependencies; declared CommonJS module directories are exposed through the runner's controlled `NODE_PATH`.
