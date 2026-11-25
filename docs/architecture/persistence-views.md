# Persistence views and store ownership

Part of [Community platform architecture](../architecture.md#persistence-pattern). Registered synchronous in-process views and PostgreSQL store ownership invariants.

## Registered in-process views

By default a store reads the database. A synchronous view is allowed only where a
caller cannot await, and each one is listed here with its source of truth and
invalidation.

| View | Owner | Synchronous reader | Source of truth | Refreshed |
| --- | --- | --- | --- | --- |
| Session signing key | `PostgresSessionKey` | session and plugin-download HMAC | `session_signing_key` | loaded once at startup; never changes |
| Shared models | `PostgresSharedModelStore` | model and web-tools upstream routing | `shared_model_*` | after each committed save; startup reloads; initialization publication retry rereads the committed revision without another save |
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
