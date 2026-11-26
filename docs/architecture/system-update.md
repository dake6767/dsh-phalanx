# System update transaction and host admission

Part of [Community platform architecture](../architecture.md#system-update-transaction). Detailed invariants for release compatibility, owned cleanup, backup and PostgreSQL recovery, nftables admission fencing, Debian/Ubuntu host admission and the root executor. See [System update transaction](../architecture.md#system-update-transaction) for the core transaction model and [Rebuildable data root](../architecture.md#rebuildable-data-root) for data-root layout ownership.

## Compatibility and release manifests

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

## Owned cleanup, backups and database recovery

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

## Admission fence and maintenance pages

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

## Host admission and root executor

Installation admits Debian-family Linux amd64 through `ID` and `ID_LIKE`, with
Ubuntu 24.04 and 26.04 on the verified list. Other Debian-family distributions
remain unverified and receive a warning without an additional confirmation.
`installer_config.py` owns the distribution and version policy;
`installer_host.py` owns dependency preparation and capability observations,
shared by installation and upgrade preparation. The family check precedes host
writes. After dependency preparation, the managed `/usr/bin/podman` must be at
least 4.9.3 and `/usr/bin/pasta` must report passt at least 0.0~git20240220,
with systemd, an available user manager, cgroup v2 and
rootless Podman. When the pasta binary omits its build version, the installed
passt package version supplies that observation; an absent or unreadable version
is rejected. Fresh installation probes an independently owned temporary
identity and completes its cleanup before creating the product identity or
writing product configuration. Existing installations inspect their own identity
without stopping its user manager. The runtime observes the pasta executable resolved
by Podman through its official info output and checks its successful help output
through a terminal, preserving options that buffered pipe output can omit.
When supported, `--host-lo-to-ns-lo` explicitly retains host loopback to namespace
loopback forwarding; older helpers retain their original arguments. DSH and the
host published port remain bound to 127.0.0.1, with the confined gateway return
path, UDP/ICMP restrictions and rootless isolation preserved. An unreadable helper
capability refuses startup rather than silently assuming older behavior.
The independent executor and administrator UI use this same transaction; they do not
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

The root executor owns an independent rootless Podman Unix API service for
image inspection. Each inspect reads actual image facts and retains the existing
image checks; only the authenticated transport is reused. UID, GID, peer PID,
start ticks, owned process group, executable and socket URI bind the peer.
Changes to the Podman configuration discard that service; executor shutdown
closes the connection, reaps its service and removes its owned runtime directory.
Standalone installer invocations retain the CLI inspection path.

Capacity-aware upgrade protocol 3 binds storage estimates and a small updater
inventory to the selected release. `installer_storage.py` groups peak writes by
actual filesystem, including Podman image-copy staging, and fails closed before
download or stop. The public bootstrap path validates exact-commit module hashes
and replaces only the root updater bank; the current platform stays running.
Legacy executors reject this protocol before acquiring platform archives.

## Python installer architecture

The Python installer, upgrade executor and deployment CLI under `scripts/install/`
and `scripts/download-sources.py` run with root host privileges and follow an
explicit four-layer dependency model enforced as an acyclic DAG by
`scripts/check-python-architecture.py`:

| Layer | Modules | Dependency and boundary constraints |
| --- | --- | --- |
| **L0 Standalone** | `installer_upgrade_gate.py` | Must import zero other `installer_*` modules so it runs standalone after being copied to `/opt/dsh-phalanx/maintenance/gate.py` for root boot admission |
| **L1 Pure / Core** | `installer_compatibility.py`, `installer_questions.py`, `installer_upgrade_core.py`, `installer_executor_protocol.py` | Pure values, compatibility and protocol logic; forbidden to import OS/network I/O modules (`subprocess`, `socket`, `urllib.request`, `http.client`, `fcntl`, `shutil`, `tempfile`, `os`, `pathlib`, etc.) or call `open`/`__import__`; may import L1 only |
| **L2 Host & Adapters** | `installer_host.py`, `installer_config.py`, `installer_progress.py`, `installer_storage.py`, `installer_release.py`, `installer_upgrade_backup.py`, `installer_executor_install.py`, `installer_cleanup.py`, `installer_database.py`, `installer_upgrade_host.py`, `installer_operations.py`, `installer_deployment.py`, `installer_uninstall.py`, `installer_executor_bootstrap.py` | Host and operational adapters; may import L0, L1 and L2; forbidden to import L3 |
| **L3 Entry / Inbound** | `installer_executor_server.py`, `installer_executor.py`, `installer_upgrade_cli.py`, `installer_deployment_cli.py`, `installer.py`, `updater.py`, `preview.py`, `scripts/download-sources.py` | CLI and Unix HTTP entry wiring; may import L0–L3 without cycles |

Every `.py` module under `scripts/install/` must be registered in this layer
table; unregistered files fail lint.

- **Standalone `install.sh` concatenation and global namespace uniqueness.**
  `scripts/install/build-installer.mjs` concatenates standalone installer
  modules in topological order into one shared Python namespace and strips
  single-line `from installer_* import ... # embedded-*` lines. The static gate
  verifies that concatenation order satisfies every `# embedded-*` dependency,
  every stripped import carries the exact trailing `# embedded-*` marker without
  renaming, every imported symbol is exported by an earlier concatenated module,
  no concatenated module imports a non-concatenated local installer module, and
  top-level function, class and constant definitions are globally unique across
  concatenated modules (one owning module per shared constant).
- **Structured executor inventory whitelist.** `installer_executor_install.py`
  (`executor_package`) validates the release-bound `updater/` directory by
  structural invariants rather than hardcoded historical module lists:
  `executor-files.json` must be a non-empty deduplicated list of strings that
  includes `updater.py` with every remaining entry matching
  `^installer_[a-z_]+\.py$`; the `manifest.json` `files` key set,
  `set(declared) | {'updater.service.in', 'executor-files.json'}`, and the
  actual directory entries (excluding `manifest.json`) must match exactly; total
  inventory files in `manifest.json` may not exceed 64 while preserving the 16 KiB
  `manifest['updater']` and 4 MiB `updater.json` size bounds; every entry must
  be a regular non-symlink file matching its SHA-256 checksum, and every `.py`
  file must compile cleanly. `installer_executor_bootstrap.py`
  (`bootstrap_executor`) checks internal manifest and hash consistency of the
  selected release-bound `updater.json` and delegates package verification to
  `executor_package`, retaining official release SHA-256 and exact-commit trust.
- **Law 3 error-code branching.** Business control flow in Python delivery
  modules branches on `InstallError.code`, `update_error_code` or typed
  exception subclasses rather than inspecting stringified exception text
  (`str(err)`, `err.args`, `.message` or `.failure`). Only the two explicitly
  declared operator display localization mappers
  (`installer_progress.operator_text` and
  `installer_deployment_cli.reason_text`) are exempted from this check.
- **Tiered zero-dependency static gate.** `scripts/check-python-architecture.py`
  (with `scripts/check-python-ast.py`) uses only the Python 3 standard library
  (`ast`, `tokenize`) and runs inside `pnpm lint` alongside
  `node scripts/install/build-installer.mjs --check`. Product delivery files
  (`scripts/install/*.py` and `scripts/download-sources.py`) enforce all seven
  rule groups (syntax/scope/unused symbols, zero-exception ban on semicolons and
  inline compound statements, 500-line code limit with executor-only ratchet in
  `architecture-exemptions.json`, four-layer DAG, Law 3, `install.sh`
  concatenation/namespace uniqueness, and catalog/wording boundaries).
  Development scripts (`scripts/dev/*.py`) enforce syntax/scope/unused symbols,
  zero-exception ban on semicolons and inline compound statements, and the
  500-line limit with zero exemptions. Test fixtures (`tests/fixtures/*.py`)
  require clean `ast.parse` and `compile` syntax verification.
