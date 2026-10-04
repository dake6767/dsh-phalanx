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
retired usernames plus stable opaque space identities and persisted directory mappings. The account administration owner serializes management writes
and rechecks the admitted actor’s role and session epoch before execution.
The store protects the last enabled administrator inside a write transaction.
Stopping failures keep the target account disabled and visible for retry; deletion
retires the space only after confirmed termination and leaves its directory intact. Reused
usernames receive a new space, session binding and model access token. Version 3
account migration retains old directory mappings; schema 4 makes email optional while preserving existing accounts. Session format 3 binds cookies
to both username and space ID.

`CommunityEntry` supplies the current account's `/app/<spaceId>/` mount.
HTTP and upgrade intake authenticate and compare that mount before stripping
the prefix or starting a runtime. Login exchange and proxy responses scope DSH
cookies to the mount and add Secure under HTTPS. Runtime launch uses the official
WebServer index tap to make manifest requests carry credentials, and the official
`--public-url` seam for the browser origin and mount, while the readiness token
exchange and shared model gateway use private loopback listeners. A displayed
HTTPS URL never changes those private transports into public model endpoints.
Public account facts and community management DTOs exclude credentials and private state. The community entry is the sole product composition. Deployment configuration retains
`DSH_PHALANX_REGISTRATION_ENABLED`, defaulting to `false`. Open registration is outside
0.1.0: `true` is rejected during configuration validation and public registration
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

Design tradeoffs are recorded in the public [ADRs](adr/README.md). Developer
setup and target-specific verification are in [development](development.md).

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
