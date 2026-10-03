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
| Web CLI arguments | `dsh/cli.ts` | `adapters/community-runtime-driver.ts`, `dsh/container.ts` |
| Private web-profile paths and patch layout | `dsh/profile-layout.ts` | `adapters/community-profile.ts`, `dsh/container.ts` |
| Non-root container identity, mounts and confined pasta return path | `dsh/container.ts` | `adapters/community-runtime-driver.ts` |
| CLI readiness and launch URL | `dsh/readiness.ts` | `adapters/runtime-process.ts` |
| Launch-token exchange cookies | `dsh/launch-token.ts` | `adapters/dsh-session.ts` |
| Session RPC, native mux frames and activity query | `dsh/session-protocol.ts` | `adapters/dsh-session.ts`; native traffic passes through the entry unchanged |
| Anthropic Messages transport and default gateway URL | `dsh/model-protocol.ts` | `adapters/community-model-upstream.ts`, `inbound/community-model-gateway.ts` |
| Absent model defaults in writable native profiles; workspace invocation overlay | `dsh/community-profile.ts` | `adapters/community-profile.ts`, `adapters/community-runtime-driver.ts`, `dsh/container.ts` |

DSH remains an external frozen dependency. Upgrade these seam owners against its
official interfaces before changing transport. Native Settings, account-login
surfaces and plugin management belong to each user's DSH instance.

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
No migration exception or excluded community subtree bypasses these gates.

## Runtime guarantees and boundaries

The default community composition wires `CommunityAccountStore`,
`CommunityOnboarding`, `CommunityAccountAdministration` and `CommunityEntry`. The fresh community SQLite schema
owns password hashes, the one-time bootstrap marker, the single admin flag and
retired usernames. The account administration owner serializes management writes
and rechecks the admitted actor’s role and session epoch before execution.
The store protects the last enabled administrator inside a write transaction.
Stopping failures keep the target account disabled and visible for retry; deletion
retires the identity only after confirmed termination and leaves its directory intact.
Public account facts and community management DTOs exclude credentials and private state. The community entry is the sole product composition. Deployment configuration retains
`DSH_PHALANX_REGISTRATION_ENABLED`, defaulting to `false`. Open registration is outside
0.1.0: `true` is rejected during configuration validation and public registration
URLs remain closed.
`CommunityInstanceLifecycle` owns per-user admission, pending starts, liveness
replacement, activity fences and shutdown through `CommunityRuntimeDriverPort`.
`CommunityRuntimeDriver` owns process/Podman I/O and handles keyed by exact instance
identity. `ports/clock.ts` defines the clock;
`adapters/system-clock.ts` owns the real clock used by idle reclamation.
Startup deliberately rebuilds containers matching community plus data-root labels;
it never removes user files. Rootless
identity and launch flags remain owned by `dsh/container.ts`. Container mode uses
a separate loopback model listener and closes the public model route.
`CommunityModelAuthorization` reads fresh community account state before and after
request intake. `FileCommunityModelAccess` owns protected durable opaque per-user
tokens; `StaticCommunityModelUpstream` owns the outgoing static provider key.
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
model rows are supplied there, below user overrides; the community invocation
overlay only supplies workspace confinement and carries no model route guard.

The rootless container is the integrity boundary for each user's private home,
workspace and configuration. Process mode is development and diagnostic mode
and makes no isolation promise. Instance ownership lives in memory; restart
recovery rebuilds owned containers from durable account identity and data-root
labels, preserving private files and native settings. Profiles remain private to each user.
