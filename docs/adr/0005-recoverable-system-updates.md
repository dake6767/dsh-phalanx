# 0005: recoverable system updates

The system update is a fixed combination of platform, management UI and DSH
image. Preparation keeps the old service running. Application immediately closes
work admission and stops the platform and its owned user instances. There is no
idle-task waiting, countdown or historical downgrade operation.

Release manifest schema 2 declares protocol 1, a source version interval, account
schema source range and target, and a user-environment epoch. The Linux platform,
DSH revision, source commit, platform checksum and image digest remain mandatory.
Protocol 1 requires identical DSH revision and environment epoch. A release that
changes delayed per-space migration must change its epoch; this protocol refuses
it before cutover. Existing pending 0.1.1 first-entry preparation is unchanged.
Future DSH or environment changes need another reviewed migration protocol.
Legacy manifests are recognized only for their historical 0.1.0/0.1.1 formats;
0.1.1 can enter the new protocol using the new installer. An undeclared legacy
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
