# Runtime guarantees and boundaries

Part of [Community platform architecture](../architecture.md#runtime-guarantees-and-boundaries). Subsystem invariants covering container isolation, MCP services, plugin delivery, member spaces, skills, execution, service preview and paused expert interfaces.

## Process host and MCP runtime

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
handoff. Removal and shutdown settle waiters. A shared Node.js catalog entry
prepares dependencies from the pinned lockfile with lifecycle scripts disabled.
Runtime launch uses the prepared dependency. Import and test leave grant and
publication decisions to the administrator.
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
For remote HTTP, a template with any missing credential slot omits its entire
header or query parameter. Declared header names belong to the platform, so a
member request cannot supply a value for an omitted header. Shared process
environment templates substitute missing credentials with empty strings.
Platform credentials stay outside member mounts and management replies. Each request
uses current templates and tool policy; JSON and incremental SSE list replies omit
disabled tools, and a batch containing a disabled call is rejected before forwarding.
Response values and protocol metadata mask the configured secret. Usage records include authenticated `tools/call` metadata and outcomes, never protocol discovery, arguments or outputs. Administrator discovery travels through the same authenticated gateway,
initializes an MCP session and follows tool-list pagination, then closes the session.
Its generation-checked snapshot cannot overwrite concurrent settings changes. A
failed test preserves the previous tool snapshot and records failure; UI discovery
runs on explicit test or reopening a tested service, without background polling.
Editing an optional remote credential keeps a tested service available. A manual
test probes the saved settings while the service remains available and then
records the result against that configuration generation.

Catalog updates keep the active service and a private candidate in the same MCP
store transaction. `McpServices` owns activation and checks the originating actor
and base generation before accepting discovery. Candidates use reserved internal
names for administrator-only discovery, never member projection or grants.
Preparation inventories include both active and candidate inputs; a promoted
service retains the candidate preparation identity to avoid reinstalling a tested
artifact. Existing carrier leases protect old dependencies until reconciliation
has stopped their readers. Restart interrupts candidate work and preserves the
active service; an explicit retry has a new durable operation identity.

## Public entry, system status and accounts

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
to both username and space ID. Directed member sign-in fixes the username and space, requires the target password even for a remembered account, and enters its DSH regardless of administrator role. The original valid administrator token is retained, including when its remembered-list entry was missing; both identities count against the ten-account limit before cookies change.

## Plugin library, delivery and access

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
`NativePluginDownloads` binds short-lived retained-archive access to the current member, space, session epoch and checked artifact. The private gateway terminates only the synthetic archive destination before ordinary HTTP/CONNECT forwarding; it rechecks eligibility after opening the archive. `MemberNativePlugins` refuses to replace an existing native copy through ordinary installation. Its native manager downloads and verifies the main archive inside the member container, retains it under the web profile, then supplies that local path to the official install RPC. The call uses the platform npm registry for transitive dependencies without changing the member’s saved registry or approving build scripts. Removal calls the official native bundle RPC independently of the library shelf.
Replacement preparation has separate durable candidate state; the checked current
version remains selected until an administrator confirms the fresh group/member
impact. Known version integrities survive replacement, preventing changed uploads
from reusing an earlier version identity. A checked GitHub commit can provide new content at the same package version; the old archive identity stays available for native comparison. Removal first persists an unpublished
removal intent, which excludes the package from selection and distribution, then
clears all grants and deletes the library row. Startup resumes interrupted removals
before accepting requests. Immutable artifacts remain available to running mounts.
`PluginCompatibility` gates startup on checks for the platform-version/runtime pair.
For releases that declare an equivalent predecessor, an available current version
verified on that predecessor keeps its preparation ID and publication when its
runtime matches. Candidate compatibility is evaluated separately. Other upgrades
recheck versions from retained original bytes and persist publication intent before
asynchronous work on the current version. Incompatible plugins retain
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
delivery source, version and checked archive digest by immutable member space plus package; native removal and disabling do not rewrite history. Cards read the actual native inventory:
a current dependency on a retained platform archive can be removed here, while an
independent native copy is preserved. Missing source metadata remains independent;
no durable history is used to infer the current copy or its version. An explicit
update matches the current DSH version and source, package lock, and retained
archive bytes with a successful platform delivery and checked library identity.
Downlisting removes the update action even for preinstalled copies; their group
assignment and installed files remain.
The signed route stages the selected archive and confirms the live update grant
through the private download gateway before changing the profile. It preserves
compatible overrides and bundle selection. After a failure it attempts to restore
the affected overrides and reinstall the verified prior archive. If recovery cannot be confirmed,
the profile retains the old archive and recovery files. The runtime keeps the
same carrier through replacement and recovery.
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

## Member spaces, lifecycle, models and network

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
`CommunityMemberInstances` binds administrator operations to the displayed target space and rechecks current authority before stopping, before starting and after startup. The lifecycle atomically refuses conflicting states and removes a newly started carrier if its authorization changed. These operations preserve native configuration and files.

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
parses the request body once and routes it by the supplier's configured protocol; the upstream transport serializes the routed object once. `FileCommunityModelAccess` owns protected durable opaque per-space
tokens. `PostgresSharedModelStore` owns private shared-provider state; the model projection owners publish public configuration per member space. `SharedModelAdministration` checks administrator authority, revision and default supply. `SharedCommunityModelUpstream` captures the selected provider at admission and injects its key only at the outgoing supplier transport selected by its protocol. Shared catalogs contain opaque model identities and provider labels, without upstream keys.
`CommunityWebToolsGateway` authenticates the member token, forwards approved Search fields
without the original question, rechecks identity after upstream response headers, and bounds
request size, response size and call duration. It rejects redirects and records each attempt
through `UsagePolicy`. `PostgresPlatformSearchSettings` stores the independent deployment-wide
credential in a field-bound envelope. The transport reads the current enabled credential per
request and sends it only to the official HTTPS Search endpoint. Rotation takes effect on the
next call. Disabling returns an unconfigured response immediately and omits the search token
from subsequent member launches. Fetch is disabled in DSH and refused at the gateway.
Container mode limits retrieval routes to the private member listener.

`PlatformVoice` owns the deployment's desired and active SenseVoice precision. The
PostgreSQL revision fences stale preparation, while the asset store verifies the
fixed bytes and SHA-256 before publishing a content-addressed model directory.
Only a ready model and VAD file are mounted read-only into a new member carrier.
Changing precision retains the active model while preparation is pending.
The native profile records the optional Bundle selection, and a PostgreSQL record preserves
a member's choice to turn it off across carrier restarts.
DSH runs recognition inside the member carrier with its native CPU worker.

Native plugin service bindings are configured in plugin access administration.
The platform verifies the delivered package and processes each binding in the
member instance. Revisioned RPC bindings use the plugin’s declared settings
service. JSON settings bindings verify the archive identity and update declared
fields in the member’s DSH home. Startup applies JSON bindings and retains the
member’s unrelated settings. The gateway checks member, space, carrier, package,
service and backend scope before attaching the real upstream credential. A
member-visible setting called `apiKey` can carry this scoped platform token.
Member-owned keys entered in the plugin use the plugin’s storage.

The release visibility rules hide expert, usage and contribution interfaces.
Their persistence and internal owners remain part of the architecture and
deployment backup.

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
host-interface/configured-public-origin facts and the declaration of additional
public IPv4 ingress aliases. A missing declaration fails external access closed;
an explicit empty list permits normal public egress while all known host, private,
loopback and declared aliases remain denied. `NodeNetworkTransport` owns pinned
TCP/HTTP I/O with a connection/header deadline and no platform-imposed idle deadline
once connected. The authenticated HTTP/CONNECT handler shares the private gateway,
and tracked connections close with account revocation. Container proxy variables
point to that gateway while pasta keeps direct outbound access confined. Native
settings and plugin installation use the user's writable profile. Host initialization
rejects linked profile directories and patches before reading them; the prior carrier
is removed and startup is serialized, so native processes cannot race those checks.
A damaged profile fails entry with a repairable 503. Missing default
legacy model rows remain in the writable profile for upgrade compatibility. The final managed include disables ordinary native provider settings and supplies shared models through the exported generic adapter. Each member space gets its own derived catalog and watcher directory, mounted read-only only in that member's container; HMR updates volatile adapter/default configuration and announces directory changes. Members retain unrelated settings, terminals and their own plugins. Before native prompt interpolation, the watcher resolves each assembly’s provider and model variables against the current managed catalog and substitutes the readable model name. Stable IDs continue to identify routes, sessions and diagnostics; native persona templates and saved message history retain their original content.

The rootless container is the integrity boundary for each user's private home,
workspace and configuration. Process mode is development and diagnostic mode
and makes no isolation promise. Instance ownership lives in memory; restart
recovery rebuilds owned containers from durable account identity and data-root
labels, preserving private files and native settings. Profiles remain private to each user.

`FileCommunityUserSpaces` resolves the current account-to-directory mapping through its account reader and owns private home/workspace preparation.
`UserStorageGuard` reads platform-wide owner and binding rows through `UserStorageFacts` after database initialization and on each availability check; it keeps no SQL fact cache.
A stable SQL owner precedes external marker creation, followed by a compare-and-swap binding publication. A missing SQL owner never adopts an existing volume marker.
Canonical root separation, mount identity, private ownership and marker checks remain filesystem responsibilities in `user-storage-files.ts`.
Only physical mount inspection has the documented 250 ms cache. Entry and new carrier startup await availability before accessing a space.
Omitted default storage remains distinct from an explicit external volume; omitting a previously bound volume fails closed.
Default durable storage is `resolve(dataRoot) + ".durable"`, with `users` and built-in `postgres` as siblings below it; and every newly created account uses the reserved `_spaces/<spaceId>` namespace under the user root. Existing accounts retain their persisted storage keys; login, restart and environment reset do not migrate directories.
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

## Skills, execution and service preview

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
old private preparation stores are read only by the migration fallback adapter. Runtime-dependency preparation has a distinct internal process capability and container identity. Its launch validates canonical private `.trees/<id>` staging and the read-only execution bootstrap, rejecting user-space or additional mounts. Maintenance may prepare new dependency artifacts through this capability; member/resident instances, ordinary execution and unknown container purposes remain outside that allowance. The maintenance observer checks this identity and its live mounts while retaining old-work drain and unchanged-user-file assertions.

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

## Paused interfaces and expert definitions

The fixed entry visibility list in `domain/release-visibility.ts` pauses expert, usage and contribution UI and contribution tool registration. Storage, APIs, usage collection and expert projection remain active. The retained expert launch implementation creates a new session with the
expert preset, selects its currently enabled shared model, then opens that session.
Members can change models with the native model picker. The authenticated native launch route creates a fresh expert session and selects its model and optional reasoning effort through the public session controller and Agent model service; it never saves the platform default. Shared model reasoning capabilities are opt-in and live-reloaded. Reasoning usage is an optional output subset, stored separately without increasing output totals. An unavailable expert model
is reported in expert metadata and leaves new sessions on the host default.
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
