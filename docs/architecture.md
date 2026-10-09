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
| Web CLI arguments | `dsh/cli.ts` | `adapters/community-runtime-driver.ts`, `dsh/container.ts`, generated image CMD |
| Private web-profile paths and patch layout | `dsh/profile-layout.ts` | `adapters/community-profile.ts`, `dsh/container.ts` |
| Non-root container identity, mounts and confined pasta return path | `dsh/container.ts` | `adapters/community-runtime-driver.ts` |
| Isolated npm installation and package artifact preparation | `dsh/plugin-preparation.ts` | `adapters/plugin-preparer.ts` |
| Uploaded package manifest inspection | `dsh/plugin-archive.ts` | `adapters/plugin-archive-inspector.ts` |
| Offline plugin activation precheck through native inventory | `dsh/plugin-precheck.ts` | `adapters/plugin-preparer.ts` |
| CLI readiness and launch URL | `dsh/readiness.ts` | `adapters/runtime-process.ts` |
| Launch-token exchange cookies | `dsh/launch-token.ts` | `adapters/dsh-session.ts` |
| Session RPC, native mux frames and activity query | `dsh/session-protocol.ts` | `adapters/dsh-session.ts`; native traffic passes through the entry unchanged |
| Anthropic Messages transport and default gateway URL | `dsh/model-protocol.ts` | `adapters/community-model-upstream.ts`, `inbound/community-model-gateway.ts` |
| Legacy profile defaults; workspace invocation overlay | `dsh/community-profile.ts` | `adapters/community-profile.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Web environment reset carriers | `dsh/community-environment.ts` | `adapters/community-environment.ts` |
| Protected platform plugin and invocation patch | `dsh/community-platform-plugin.ts` | `adapters/community-platform-plugin.ts`, `dsh/container.ts` |

DSH remains an external frozen dependency. Upgrade these seam owners against its
official interfaces before changing transport. Unrelated native Settings, account-login surfaces and user plugins belong to each member. Shared model supply belongs to platform administration through the official managed include in `dsh/shared-models.ts`.

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
HTML templates and data fixtures can have a permanent exemption when a
comment explains their data nature. Source modules must not use that escape.

## Architecture gates

`architecture-exemptions.json` is empty. The lint rules cover all source and
community UI code, and each use case has a matching quick behavior test. Size
checks also cover CSS and executable test fixtures. Architecture rule samples run
in `tests/dependency-gate.spec.ts`; changing a rule requires independent review.
All community source and UI modules are covered by these gates.

## Runtime guarantees and boundaries

The default community composition wires `CommunityAccountStore`,
`CommunityOnboarding`, `CommunityAccountAdministration` and `CommunityEntry`. The fresh community SQLite schema
owns password hashes, the one-time bootstrap marker, the single admin flag and
retired usernames plus stable opaque space identities and persisted directory mappings. Every account belongs to one group. The account store owns ordinary groups, a single protected administrator group and the default for future accounts; role and group changes commit together. Group deletion and default changes are transactional, and account detail updates validate the email and group before committing either field. The account administration owner serializes management writes
and rechecks the admitted actor’s role and session epoch before execution.
The store protects the last enabled administrator inside a write transaction.
Stopping failures keep the target account disabled and visible for retry; deletion
retires the space only after confirmed termination and leaves its directory intact. Reused
usernames receive a new space, session binding and model access token. Account storage retains durable directory mappings and optional email. Sessions bind cookies
to both username and space ID.

`PluginLibrary` owns durable plugin additions, exact npm identities, administrator
admission, progress, retry and shutdown. `FilePluginLibraryStore` persists the
independent library under the platform data root. Failed additions have no current
version and are not published. `ContainerPluginPreparer` uses disposable rootless
containers with no member mounts or platform credentials. It verifies registry
sha512, installs through the official DSH CLI with lifecycle scripts disabled,
checks every dependency declaration and prepares runtime peers. Actual activation
is checked through the native plugin inventory in a network-disabled container
with read-only artifacts. Original archives and prepared dependencies are published
by content hash only after successful offline startup. Package patches are preserved
verbatim for managed loading. Shutdown awaits all preparation tasks; failed container
removal retains staging and blocks further preparation until ownership-checked
startup recovery succeeds. `FilePluginUpload` streams at most 50 MB into private
incoming storage and hashes the original bytes. A read-only, network-disabled
container reads the archive manifest; the host never extracts or executes uploaded
content. Accepted originals remain available for retry, duplicate uploads discard
their incoming copy, and the same version with different content is rejected.
Intake cancellation removes incomplete files after container exit is confirmed.
Library recovery removes abandoned intake files and unreferenced original archives after owned-container recovery, preserving originals referenced by durable additions.

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
replacement, serialized restart/termination maintenance, activity fences and shutdown through `CommunityRuntimeDriverPort`.
`CommunityRuntimeDriver` owns process/Podman I/O and handles keyed by exact instance
identity. `ports/clock.ts` defines the clock;
`adapters/system-clock.ts` owns the real clock used by idle reclamation.
Startup deliberately rebuilds containers matching community plus data-root labels;
it never removes user files. Rootless
identity and launch flags remain owned by `dsh/container.ts`. Container mode uses
a separate loopback model listener and closes the public model route.
`CommunityModelAuthorization` reads fresh community account state before and after
request intake. `FileCommunityModelAccess` owns protected durable opaque per-space
tokens. `FileSharedModelStore` owns private shared-provider state and public configuration publication. `SharedModelAdministration` checks administrator authority, revision and default supply. `SharedCommunityModelUpstream` captures the selected provider at admission and injects its key only at the outgoing Messages transport. Shared catalogs contain opaque model identities and provider labels, without upstream keys.
The community gateway keeps cancellation and backpressure at the shared streaming
boundary and keeps that credential outside user spaces. The composition connects proxy errors to the existing HTTP/WebSocket failure handler.

`CommunityNetworkAccess` authorizes fresh per-user tokens and pins public IPv4
DNS results through an injected resolver. `NodeNetworkResolver` owns DNS and
host-interface/configured-public-origin facts and the explicitly declared complete
public IPv4 host inventory; missing inventory fails external access closed. `NodeNetworkTransport` owns pinned
TCP/HTTP I/O. The authenticated HTTP/CONNECT handler shares the private gateway,
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

`FileCommunityUserSpaces` owns the stored account-to-directory mapping and private
home/workspace preparation. `UserStorageGuard` owns the explicit external storage
binding, canonical root separation, mount identity and ownership checks. Entry and
new carrier startup recheck availability before accessing a space. Platform persistence
is never selected as a member home or workspace; default legacy layout remains
`dataRoot/users`, and retired username reuse uses the reserved `_spaces/<spaceId>`
namespace under the user root. External storage changes require explicit migration.

`CommunityEnvironmentRecovery` owns fresh administrator and target authorization, duplicate reset coalescing and stop/backup/reset/start failure phases. It uses the lifecycle's separate `recover` operation so a pending member restart cannot skip environment preparation. `FileCommunityEnvironment` copies only official web-profile/home configuration carriers into private platform-owned backups after carrier removal; links are copied as links and special files fail closed. Completed manifests include manual restoration of present and absent carriers. It never removes the user home, workspace, sessions or old backups. Admin-only reset responses carry private backup locations and restoration instructions.

`CommunityEnvironmentUpgrade` requires a completed legacy environment backup before
native startup or upstream migration. `FileCommunityEnvironmentUpgrade` owns the
per-space receipt; repeated entry retains the receipt and model-choice notice.
New spaces are marked current without a nonexistent legacy backup. Shared model
initialization imports deployment credentials once and then honors administrator
state. Upgrade does not reopen account initialization or clear personal files.

`CommunityUserStorageMigration` orders offline maintenance, copying, verification
and publication through its port. `FileCommunityUserStorageMigration` owns the
exclusive platform lock and durable pending/verified/complete receipt, retaining
source data and the previous binding. `UserStorageBindingMigration` shares the
existing mount/ownership grammar with `UserStorageGuard`. `user-storage-copy.ts`
owns link-preserving directory copying and independent byte/type/mode verification.
Only verified data receives the new binding. The operator explicitly updates the
protected environment afterward; a mismatched or unavailable volume fails closed.
Completed retries never copy over later destination changes.

## Key decisions

**Independent community codebase.** This repository owns its source history, release inputs and supported interfaces. DSH stays external and pinned, with one owner per official seam. Independent evolution keeps changes reviewable without a shared-core or feature-matrix prerequisite; source drift and deliberate manual integration are accepted costs.

**Rootless user spaces.** Installed deployments run one rootless Podman user instance per account, with private home/workspace mounts and loopback listeners. The authenticated network return path pins public IPv4 destinations and rejects declared host aliases; missing inventory fails closed. Development mode offers no isolation. Rootless operation requires Linux host preparation and real container/network verification; it does not certify arbitrary plugins.

**Administrator-owned shared models.** Administrators own provider credentials, manual model lists and the default selection. Stable opaque identities route Anthropic Messages requests using a provider snapshot captured at admission; disabled selections fail without silent fallback. Catalogs update through official DSH seams, while keys remain in platform storage. Ordinary personal-provider settings are unavailable; terminals, user plugins and unrelated settings remain available, including external model access through user code. The gateway is not a prohibition on all external model traffic. Provider metadata does not certify maximum context or multimodal support.

**Stable authenticated user-space entry.** Each account has a durable `/app/<spaceId>/` path; the ID grants no authority. Every HTTP request and WebSocket upgrade checks the current account and space before forwarding. DSH cookies are scoped to the admitted mount, with Secure under HTTPS. The public URL and index tap use official seams, preserving native query/hash bookmarks; the cost is explicit proxy and cookie ownership rather than modifying DSH routing.

**Independent platform pages.** Login, first-administrator initialization and instance recovery are lightweight server-rendered pages independent of management bundles and native DSH. Shared appearance is applied before paint. Authentication, expiration and recovery authority remain server responsibilities; credentials stay in the fragment/form and are not retained in display preferences. The platform must still run: this is not offline login. A small shared renderer is maintained to keep recovery available when larger applications fail.

## System update transaction

The system update is a fixed combination of platform, management UI and DSH
image. Preparation keeps the old service running. Application immediately closes
work admission and stops the platform and its owned user instances. There is no
idle-task waiting, countdown or historical downgrade operation.

Release manifest schema 2 declares protocol 1, a source version interval, account
schema source range and target, and a user-environment epoch. The Linux platform,
DSH revision, source commit, platform checksum and image digest remain mandatory.
Protocol 1 requires identical DSH revision and environment epoch. A release that
changes delayed per-space migration must change its epoch; this protocol refuses
it before cutover. Existing pending legacy first-entry preparation is unchanged.
Future DSH or environment changes need another reviewed migration protocol.
Only explicitly supported legacy manifest formats can enter the new protocol using the new installer; see the target release notes for one-time upgrade steps. An undeclared legacy
upgrade cannot use link-only rollback.

A shared transaction owner implements prepare, apply, status and recover through
one host port and installation mutex. Selection pins the complete manifest bytes
and identities; apply never follows latest again. The root-only journal saves each
phase before its external effect. A completed, independently verified backup is
required before starting the target. Recovery after an interrupted switch restores
that backup and validates the old process, artifact, image and local readiness.
An original upgrade failure remains a failure even when restoration succeeds.
Restoration also saves its commit boundary before reopening writes; later recovery
starts and verifies without copying the backup again. Failed recovery blocks new preparation
and retains the current operation for server recovery.
After the durable commit point, recovery starts and verifies the new version and never rolls
back writes that may have resumed. Recovery failure leaves work admission closed.

The backup contains all mutable platform-root carriers except reserved member
`users` and the transient SQLite platform lock. Configuration, install receipt,
manifest and service unit are separate carriers, including their absence. It
copies links as links, rejects special files and verifies bytes, types, modes and
ownership. SQLite databases and their sidecars are copied after the platform and
owned containers stop and the exclusive platform lock can be acquired. Restore
also removes platform carriers created by the failed version. Member homes,
projects and external user volumes are retained without a default full-volume
copy. Protocol 1 does not migrate these native DSH carriers during validation.

A narrowly scoped nftables table fences the two managed TCP listeners independently
of application version. It admits only explicitly marked root readiness probes and rejects other
traffic during validation; it never flushes or adopts unrelated firewall tables.
Atomic carriers and their parent directories are synchronized before effects.
An independent root boot unit reinstates admission from the marker or active
journal before the exact
managed user service starts. A failed fence or verification stops the service and
owned containers. Extreme shutdown failure is reported as unverified admission.
The root-owned maintenance marker additionally blocks HTTP, model/network and WebSocket
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
grammar accepts status, formal-release check, prepare, exact-operation apply and
recovery. It accepts no command, URL, credential or deployment path. CLI candidate
handoff remains an operator-only test path. The same file lock excludes CLI and
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
