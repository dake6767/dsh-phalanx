# Operations

[简体中文](operations.zh-CN.md) · [Installation](install.md) · [Administrator guide](admin-guide.md) · [Member guide](member-guide.md)

## Storage layout

`DSH_PHALANX_DATA_ROOT` holds local artifacts, generated projections and runtime state. With the default `/var/lib/dsh-phalanx/data`, user spaces are in `/var/lib/dsh-phalanx/data.durable/users` and built-in PostgreSQL in `/var/lib/dsh-phalanx/data.durable/postgres`. Explicit external user storage and PostgreSQL keep their configured locations. Default storage does not require a separate mount; `USER_DATA_ROOT` and `USER_DATA_MOUNT` are present only when an external volume was selected.

| Layer | Persistent contents | Recovery requirement |
| --- | --- | --- |
| Platform database | Accounts, grants, settings, usage and encrypted integration credentials | Restore a consistent PostgreSQL backup |
| Platform code | Versioned platform program, updater and matching image | Restore the matching verified release bytes |
| User spaces | Member files, native settings and private reset backups | Preserve the actual user root and its ownership |
| Rebuildable area | Local artifacts, projections, caches and runtime files under `data` | Retain local artifact inputs; projections can be regenerated |
| Host operations state | Master key, database connection, deployment settings and upgrade/maintenance receipts | Restore the matching protected set; keep a separate offline master-key copy |

### Security boundary

Platform credentials use AES-256-GCM envelope encryption. PostgreSQL holds the encrypted values and the data keys wrapped with a separate master key. Authentication binds each ciphertext to its record and field.

Envelope encryption protects platform secrets when database contents or database backups leak. It does not protect against a compromised platform host or a deployer who can read the master key. Database ciphertext and the matching master key together allow decryption. Member-owned keys and files remain the member's responsibility. Keep all backups private; generated projections must not contain platform provider or integration secrets.

### Master key backup

The master key is `/var/lib/dsh-phalanx/keys/master.key`; the database connection file is `/var/lib/dsh-phalanx/keys/database.json`. Back up the master key offline, separately from database backups. Also preserve the protected database connection files and deployment environment with their original permissions. The installed key and connection file are mode `0600` and belong to the service account. To verify the installed key without printing its contents:

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start master-key-fingerprint --config-file /var/lib/dsh-phalanx/keys/database.json --data-root /var/lib/dsh-phalanx/data
```

A lost master key cannot decrypt existing secrets. Secret reset clears protected platform credentials and requires sign-in and credential configuration again; it is not a backup recovery method. After key rotation, create a new offline backup and keep any previous key/configuration set required by the retained recovery operation.

### Consistent backup and whole-host migration

Stop the platform and confirm member containers have stopped before taking a consistent backup. For a cold built-in database backup, stop its PostgreSQL service too; for external PostgreSQL, obtain a matching consistent database backup. Keep the database, master key, connection files, `/etc/dsh-phalanx/environment` and actual user root together as one deployment set, retaining ownership and permissions.

Also copy the retained local artifacts under the data root, including uploaded skill files and ZIPs, plugin archives and prepared source packages, and contribution packages. SQL references and hashes cannot recreate an uploaded original that has no download source. Copying the complete data root is the straightforward option; only generated projections, caches and reproducible runtime files may be omitted when their retained inputs are available.

Restore the matching program/image, database, key/configuration set, local artifacts and user spaces on the destination. Preserve the deployment identity and volume marker; do not initialize a new platform over existing user data. Restore external mounts before starting the service, keep the old host stopped, then verify administrator sign-in, member entry, files and configured capabilities. Never run two hosts against the same platform database. Keep the original backup until recovery has been verified.

The updater does not back up user spaces. With the platform and its member
containers stopped, archive the actual user root to private storage outside that
root. For the default user root on an installed host, for example:

```sh
sudo sh -c 'umask 077; tar --acls --xattrs --numeric-owner -cpf /path/to/private-backup/users.tar -C /var/lib/dsh-phalanx/data.durable/users .'
```

Create the private destination first; substitute the configured external user root
when one is in use. Preserve the entire root, including its storage marker and
environment-reset backups. Record which database, key and configuration match the archive. Keep the master key in a separate offline backup. Retain the archive with the other deployment records, and verify that it can be listed and restored with its original
ownership and permissions. An upgrade's automatic recovery is not a replacement
for this backup.

### Database switching and key rotation

External PostgreSQL must be version 14 or newer, with a database role that owns or can create the platform's `dsh_phalanx` schema. Use an empty schema or the matching platform database; unrelated objects are rejected. `verify-full` validates the server certificate and hostname, `require` encrypts without certificate verification, and `disable` is unencrypted. TLS failure never falls back to plaintext.

For an external target, privately prepare `/var/lib/dsh-phalanx/keys/database-target.json` with the selected connection fields (`host`, `port`, `database`, `username`, `password`, `tls`, and `ca` when needed), owned by `dsh-phalanx`, mode `0600`. Do not place it in the data root or paste credentials into command arguments. The managed commands use the installed configuration:

```sh
sudo /opt/dsh-phalanx/current/start database-switch --target external
sudo /opt/dsh-phalanx/current/start maintenance-status
sudo /opt/dsh-phalanx/current/start database-switch --target builtin
sudo /opt/dsh-phalanx/current/start master-key-rotate
sudo /opt/dsh-phalanx/current/start maintenance-status
```

Run one operation at a time during a maintenance window. Switching copies and verifies platform facts before selecting the target; source data is retained. Rotation rewraps data keys. Both operations interrupt member tasks and have independent maintenance receipts. Inspect the result, use `maintenance-recover` for a recoverable interrupted operation, and follow its recovery instructions instead of manually editing connection files or deleting the maintenance marker. Preserve the source database and recovery files until the new deployment has been verified.

Rotation requires a selected database with an initialized platform schema; a first administrator is not required. Before selection or schema initialization, the command refuses before entering maintenance, closing admission or stopping services. It does not change the deployment identity, database password or data keys.

If an old executor failed rotation before initialization and `maintenance-status` reports `master-key-rotate` in phase `working`, first update the independent executor with a verified installer that supports this recovery, then recover:

```sh
sudo bash install.sh --upgrade bootstrap
sudo /opt/dsh-phalanx/current/start maintenance-status
sudo /opt/dsh-phalanx/current/start maintenance-recover
sudo /opt/dsh-phalanx/current/start maintenance-status
```

This keeps the installed platform version. The initialization recovery requires the same deployment and source, a matching maintenance marker, authenticated protected configuration and master key, an unselected database or empty schema, and no product maintenance journal or staged key files. For a selected empty schema, the executor first uses the installed source database and storage owners to prepare its initial storage identity while maintenance and admission remain closed. This preparation is retryable and retains existing external-storage protections. An unselected database is not initialized. It then starts the original service, verifies the healthy entry and rechecks protected file identities, and also verifies `/readyz` when the schema is ready, before opening admission, returning `restored`. An interrupted recovery can be retried. Changed files, other phases and other maintenance actions cannot use this shortcut; an existing product journal follows its original operation recovery. On failure, retain maintenance state and diagnostics; do not remove the marker manually.

## Service management and recovery

Use the global deployment command on the installed Linux host:

```sh
sudo dsh-phalanx status
sudo dsh-phalanx stop
sudo dsh-phalanx start
sudo dsh-phalanx stop --yes --language en --output json
```

`status` is read-only and reports the platform, member instances, built-in database and update/maintenance workers separately. Partial or failed observations return a nonzero exit code. `stop` interrupts member tasks and asks for confirmation in an interactive terminal; automation must explicitly pass `--yes`. It stops verified services, member containers and independent maintenance workers owned by this deployment, retaining data, keys and original boot startup settings. External databases, shared HTTPS edges and other deployments remain separately managed. `start` uses the existing configuration and resident-instance policy; interrupted tasks do not resume automatically. Repeating an action when its target state is already reached does not restart components.

Start and stop refuse conflicts with installation, update or database maintenance. Complete or recover that operation first. If a stop partly fails, inspect its component results, correct the condition and retry; partial success does not confirm a whole-deployment shutdown.

### Uninstall and recover a deployment

```sh
sudo dsh-phalanx uninstall
sudo dsh-phalanx uninstall --purge
```

Default uninstall stops the deployment, removes the managed programs and services,
and disables deployment autostart. It retains the member spaces, platform
database, matching master key, protected configuration and recovery receipt
together. Keep that set intact. The command reports the exact release to reinstall
with `sudo bash install.sh --version <reported-release>`. Use the corresponding
verified installer and release assets. The installer checks the retained
configuration and key before starting the deployment.

Use `--purge` to explicitly remove verified local deployment data, including
the built-in database and the dedicated member directory on an external volume.
The command lists its scope before confirmation. After default uninstall, run
`sudo bash install.sh --uninstall --purge` with the verified installer to manage
retained data. External PostgreSQL, system accounts and dependencies, shared
resources and the external volume itself are retained. Keep the configured data
volume mounted. If the deployment database could not verify the external member
directory before uninstall, reinstall and start the retained release to verify
that binding before purging. Use `--yes` for confirmed noninteractive execution.

A nonzero exit reports an incomplete operation. Correct the named condition and
retry the same uninstall or purge command. If the global command has already
been removed, use the corresponding `install.sh --uninstall` command to resume.

These lower-level commands operate only on the platform user service and support restarting it after configuration changes:

```sh
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user status dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user restart dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user stop dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user start dsh-phalanx.service
```

Stop does not disable boot startup. Use `systemctl --user disable --now` with the
same prefix to suspend startup; `enable --now` restores it. An optional HTTPS
edge unit is managed separately; never restart shared nginx to operate this platform.

Edit `/etc/dsh-phalanx/environment` with sudo for existing configuration changes,
then restart this service. Preserve its ownership and 0640 mode. The configuration
remains protected deployment configuration; do not paste it into issue reports. Shared model credentials and session keys are encrypted in PostgreSQL.
Follow [consistent backup and migration](#consistent-backup-and-whole-host-migration) to preserve the database, keys, connection/deployment configuration, artifacts and actual user root together. Ordinary restart
rebuilds owned containers and keeps native profiles/files and the member container
hostname. Existing owned containers provide their hostname during an upgrade;
keep the private platform data root when backing up or moving the installation.
The platform recovers a DSH web profile write lock when it can verify that
the owning instance has exited and the lock still belongs to that instance.
It preserves locks whose ownership or status is uncertain. Use the application's
recovery procedure for other kinds of locks.
Account deletion also
preserves files. See the deployment uninstall procedure above for local data removal.

For a failed installation, retain configuration/data, inspect the named failure,
correct network/dependency/port problems and rerun the same verified version.
An archive hash mismatch must be repaired by obtaining the original matching
assets; never edit the checksum inventory. Automatic rollback applies to failed
activation. An intentional rollback requires the previous completed release and
matching image/configuration and the consistent backup taken before upgrade.
Automatic reverse migration of data written by a newer DSH is not provided.

## Separate user storage

The system service keeps platform data at `/var/lib/dsh-phalanx/data` and defaults
user storage to `/var/lib/dsh-phalanx/data.durable/users`. For a new deployment on a separate disk,
mount it and configure its boot mount before running the installer:

```sh
sudo bash install.sh --version vX.Y.Z --user-data-root /mnt/data/dsh-phalanx-users --user-data-mount /mnt/data
```

The installer prepares a new or empty user directory with service ownership and
mode 0700. It does not adopt nonempty directories. Both options are required for
external storage. Container mode requires an actual independent mount exactly at
the declared mount point; a mounted parent does not satisfy it. The resulting
protected configuration uses `DSH_PHALANX_USER_DATA_ROOT` and
`DSH_PHALANX_USER_DATA_MOUNT`. Development mode permits a host directory without
claiming isolation.
The external user root must not overlap platform data. The platform does not format
disks, manage host mounts, or recursively change existing data ownership.

The platform database holds the durable storage identity and selected volume binding;
the volume-side `.dsh-phalanx-storage.json` marker identifies the corresponding volume.
Restore the database, matching key/configuration and volume together: recreating platform data at the same
path cannot adopt an existing user volume. Missing or incorrect mounts, ownership and write permissions fail
closed; do not edit or remove those files to bypass a failure. Restore mounts before
the service starts. Both home and workspace follow the user root while container
paths stay stable. Platform accounts and provider credentials remain outside member
mounts. Existing directories retain their durable mappings. Changing storage on an
existing deployment requires an explicit migration; editing or removing the variable
does not move data. Back up both roots, configuration and permissions together.

Every new account, including the first administrator, stores its home and workspace under `_spaces/<spaceId>` in the user data root. Existing accounts keep their stored directory mapping; no old directory is moved or removed.

The management API exposes a persistent opaque `spaceId`. Recreating a deleted
username creates a different space and does not restore its files, sessions or model
access credentials. Upgrading the session format requires signing in again.

Members enter `/app/<spaceId>/` after login. The old root entry redirects there;
administrators retain `/admin` and its Open DSH link. The platform checks the
current account and space ownership for every HTTP and WebSocket request. DSH
cookies, plugin assets, RPC and manifest use the same mount. Configure the exact
browser-facing `--public-origin` when terminating HTTPS at an external proxy;
forward the full path and WebSocket upgrades to the platform.

## Move user storage to another mounted volume

This is an explicit offline operation on installed container deployments. Prepare
and mount the new volume yourself; the tool never formats a disk. Configure its
persistent mount in the host's normal boot configuration and verify it is mounted.
Create a private parent directory below that mount, owned by `dsh-phalanx` with mode0700, then an empty target directory with the same ownership/mode inside it. The tool stages its copy beside that target.
Do not choose the mount point itself or overlap the platform or source user root.
Keep enough free space for a complete copy. The source remains intact.

1. Stop the user service with the service command above. Save a private copy of
   `/etc/dsh-phalanx/environment` before editing it, and back up platform state.
   Keep PostgreSQL available during the offline operation. Stopping the platform
   also stops its built-in database; start only that database before running the tool:

   ```sh
   sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) \
     systemctl --user start dsh-phalanx-postgres.service
   ```

   External PostgreSQL deployments keep their existing database service running.
2. Run the installed tool as the service account with the original protected
   environment. It acquires the platform maintenance lock, removes only owned
   containers, copies links as links, compares file bytes/types/modes/link text,
   and publishes the new volume binding only after verification:

   ```sh
   sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) sh -c '
     set -a
     . /etc/dsh-phalanx/environment
     set +a
     exec /opt/dsh-phalanx/current/start migrate-user-storage \
       --target-root /mnt/new-data/dsh-phalanx/users --mount /mnt/new-data
   '
   ```

3. After success, edit only `DSH_PHALANX_USER_DATA_ROOT` and
   `DSH_PHALANX_USER_DATA_MOUNT` in the protected environment to the reported
   target and mount. Preserve all credentials, the platform root and its ownership.
   Restart the service, sign in to existing spaces, and verify projects, chats,
   personal files and model access. Verify the same files again after host reboot.

A private JSON receipt and recovery `README.txt` live in `storage-migrations/`
beside the protected database configuration file, outside the platform data root.
They record the source, target and previous SQL binding with its revision.
Copy/verification failure leaves the old binding authoritative. Keep the service
stopped and the original environment to retry the identical command. A published
binding with old configuration fails closed until configuration is explicitly
switched; it never substitutes an empty home. After a verified destination marker
has been published, retry resumes only the SQL publication and preserves later
destination files. A completed retry validates the volume without recopying.
Linked parents, special files, wrong ownership, missing mounts and unwritable
roots are rejected. Correct the named obstruction explicitly.

For rollback, stop the platform and preserve destination changes made after
cutover. Rerun the command above with `--rollback` and the **same original
`--target-root` and `--mount` arguments**. It removes only owned carriers,
validates the retained source and restores the previous SQL binding with a
revision check; a later storage switch is rejected. Neither tree is recopied or
deleted. Restore the original protected environment before restarting. If the
rollback result reports `targetMount: null`, remove the two explicit user-data
settings to restore default storage. Preserve the platform storage identity,
both copies and the private receipt. Restore the source mount if it was external,
then restart and verify its original files before reopening access. Follow the
receipt's recovery instructions; do not erase binding facts to bypass a missing disk.

## Download sources

In **System settings → Download sources**, choose **Official** or **Mainland China**, then edit individual addresses if needed. The categories cover npm, PyPI, Docker Hub/GHCR images, GitHub assets, the GitHub API and browser downloads. Fresh installations default to Official. The protected saved selection is reused by runtime preparation and later updates; switching a preset resets its per-category overrides. Empty image mirror and GitHub prefix fields mean direct access.

```sh
sudo bash install.sh --download-source-preset mainland
```

Installation also accepts `--npm-registry`, `--pypi-index`, `--container-mirror`, `--ghcr-mirror`, `--github-proxy-prefix`, `--browser-download-host`. Use credential-free URLs; container mirrors require HTTPS. `--github-api-proxy-prefix` sets the GitHub API prefix. Plugin prechecks from GitHub use the API prefix to resolve the default branch and the asset prefix to fetch source; installation and upgrades read release assets only and do not use the API prefix. Command-line choices apply to that invocation; initial choices are persisted, while an existing administrator selection remains the default for subsequent operations.

The Mainland China preset uses npmmirror for npm, TUNA for PyPI, DaoCloud for Docker Hub, NJU for GHCR, ghfast for GitHub assets and gh-proxy.org for the GitHub API. Browser downloads use npmmirror, with a separate Chromium override for mirror path gaps; see [runtime preparation](skill-execution.md#prepare-dependencies-and-refresh). Mirrors are external services and can become unavailable; edit the affected category when necessary. The source changes the download route; release identity, checksums and image digest checks still apply.

The platform's npm source controls managed-plugin preparation and its registry preflight. DSH's native plugin manager retains its own registry selector, including its npmmirror option; changing the platform setting does not rewrite that native selection.

### Egress proxy

Installation, CLI and management-page updates, image pulls, Git imports and
runtime dependency preparation honor `HTTPS_PROXY` / `https_proxy` and
`NO_PROXY` / `no_proxy`. Lowercase wins when both spellings are supplied.
For first installation, export the variables and preserve them through sudo:

```sh
sudo --preserve-env=HTTPS_PROXY,https_proxy,NO_PROXY,no_proxy bash install.sh
```

Use a private shell input or protected file for a proxy URL containing credentials;
do not put it in command history, skill URLs or diagnostic reports. Installation
saves the configuration in `/etc/dsh-phalanx/environment`, the deployer-owned,
protected systemd environment file shared by the platform and updater. Saved
configuration takes precedence over the invoking shell on subsequent operations.
After editing that file, restart `dsh-phalanx.service` and
`dsh-phalanx-updater.service`. An empty `HTTPS_PROXY` disables the saved proxy.
`NO_PROXY` preserves your comma-separated exclusions and always includes loopback
hosts. Private gateway and preview traffic stay local. Deployer proxy credentials
are not copied into member environments or preparation logs.

Download-source prefixes choose the destination URL; the egress proxy chooses
how to reach it. Both can be configured together. Trusted download processes also
use this proxy for HTTP destinations, including Ubuntu package repositories. Proxy failures identify
`HTTPS_PROXY` / `NO_PROXY` without printing credentials. Git additionally accepts
`GIT_SSL_CAINFO` for a custom trusted CA. The installer supplies Git and upgrade
preparation installs it when missing.

## Recoverable system updates

A release can require a fresh installation. In that case, checking for updates refuses an in-place upgrade and does not offer a download or apply action. Back up the existing deployment and master-key file before provisioning a separate fresh installation; keep the original deployment until its data is no longer needed. The current installer also refuses the upgrade before querying an unsupported legacy database. Older installed pages may show a general incompatibility reason; follow the installation guidance in the release notes.

For a compatible in-place update, the updater stops the old platform and owned
instances, then exports every registered PostgreSQL schema and backs up keys,
connection configuration, deployment configuration and the database service unit. The archive tool matches
the selected server's major version and is obtained before downtime. Failed
migration or validation restores these together before starting the old version.
Unrelated database schemas remain outside recovery. User-space files are not
included: retain your own consistent backup using the procedure above. After old
work has drained, validation keeps user storage read-only and starts no member
or resident instances until commit. Rebuildable artifact and projection trees stay
in place and are not collected during maintenance. Recovery checks that their
recorded directories still exist before replacing platform data. Successful
upgrade or restoration removes its temporary backup; recovery failure retains
it and keeps maintenance closed.

During downtime, members see a bilingual “System upgrade in progress” page that
checks readiness and refreshes automatically. Existing WebSocket sessions end.
Older installed releases without a packaged maintenance page may reset the
connection until the target listener starts. Member work stays closed throughout
validation; the readiness response alone does not reopen it.

System update shows the action available in the current state, including a
required intermediate version or conversion to the same-version formal release.
Applying requires confirmation that running tasks will be interrupted and member
files are outside the upgrade backup. During the operation, the page shows its
phase and downtime; completion shows the total downtime and phase durations.
Known diagnostics follow the platform language. Unrecognized errors retain their
original message and a restricted server log path for investigation.

Before downloading database tools or platform assets, unpacking, image import, and service shutdown, the
updater checks the actual filesystems used for cache, release trees, rootless
image layers and temporary downloads, platform data and backups. Locations on
one filesystem share one available-space value; the estimate conservatively
reserves all new writes. Existing images are reused without another layer
reserve. For a different image, only its matching layer prefix already present in
the verified current image reduces the estimate; offline import still reserves
space for the whole archive staging area. Missing capacity facts or insufficient space stop preparation while
the current service keeps running. The update page and JSON operation report
show required, available and missing bytes, plus backup capacity including the
estimated database export. Capacity is checked again before applying; concurrent disk use can
still change free space after a check.

Before the first download, and after a verified upgrade reopens the service, the
updater reclaims only resources whose managed installation receipts and image
identities prove ownership. It retains the current and most recent successfully
used previous release, prepared targets and unfinished recovery resources. All
running and stopped container references and active program references are
protected. Verified historical update backups are removed; the current operation
remains protected until its own successful upgrade or restoration releases its
backup. Unknown resources, user data and recovery executors remain. Capacity is measured again after cleanup; retention is never
relaxed to make an update fit.

System update shows observed reclaimed bytes and per-resource retention reasons.
Shared layers and additional image names are not counted as separate disk usage.
An update can succeed while cleanup fails; **Retry cleanup** retries disposal
without applying another update, stopping the service or restoring old data.
The server equivalent is `sudo bash install.sh --upgrade cleanup --output json`.
Interrupted cleanup can resume from its durable operation. Retained old artifacts
are an emergency reserve, not permission to downgrade after new writes.

When the installed updater does not support the selected release protocol or
its acceptance checks, or lacks the recovery capabilities required by that release, first download the current installer again using the
installation instructions. Reusing an old installer can reject the same new
contract before it can fetch the new updater. Then
run `sudo bash install.sh --upgrade bootstrap --version latest --output json`.
This verifies the selected release and downloads only its small, checksum-bound
updater modules from the exact release commit. It restarts the updater, leaving
the platform running. Return to System update afterward. Finish or recover an
existing prepared/interrupted operation before bootstrapping. The current CLI
installer also performs capacity checks directly during ordinary preparation.

Some older installations require this bootstrap once before their first supported
in-place update. Follow the target [release notes](https://github.com/dake6767/dsh-phalanx/releases)
for the exact transition; a later update needs it only when the installed executor
cannot satisfy the target's declared minimum reader or required capabilities.


For an installation older than the current release, read the target release notes first. Existing
ports and storage bindings are retained. Applying an update immediately restarts
the service, interrupts every running task and may lose unsaved content. Interactive
application asks for confirmation; noninteractive application requires `--yes`.

```sh
sudo bash install.sh --version vX.Y.Z --yes
sudo bash install.sh --upgrade prepare --version latest --output json
sudo bash install.sh --upgrade apply --operation <prepared-operation-uuid> --yes
sudo bash install.sh --upgrade status --output json
sudo bash install.sh --upgrade recover --output json
```

Preparation downloads and verifies a fixed compatible combination while the old
service runs. Applying that operation retains its exact target even if latest has
changed. An upgrade failure that restored and verified the old service still exits
nonzero. Recovery failure leaves maintenance closed and reports a server recovery
instruction. Preserve the restricted operation journal and verified backup; inspect
the diagnostic log before retrying recovery. Do not remove the maintenance marker
or change `current` manually to bypass a failed transaction.

The release manifest declares compatible schema ranges, an upgrade floor,
required intermediate versions and a minimum executor reader. A sufficiently
recent reader tolerates unknown fields, higher protocol numbers and new channel
attributes; it still validates known compatibility and integrity requirements.
An insufficient reader requires the verified updater bootstrap above.
Unsupported source schemas or native environment changes are rejected before
switching. The release list identifies a required intermediate version rather
than applying an incompatible latest release. Candidate deployments can use the
normal upgrade transaction to convert to a same-version formal release; the
channel changes only after commit. Arbitrary historical downgrades are not
supported. See [the compatibility and backup decision](architecture.md#system-update-transaction).

Protocol releases also install the root `dsh-phalanx-updater.service`. Its control
socket is local to the managed service identity; the Web platform still runs as
`dsh-phalanx`. An accepted update survives browser disconnection and Web service
shutdown. Inspect the same operation with the status command above. If the
executor cannot start, use the verified standalone installer's recovery command
and inspect `sudo journalctl -u dsh-phalanx-updater.service --no-pager`. Preserve
its root-owned journal and immutable executor banks while repairing the verified
release package. Keep maintenance closed until recovery verifies readiness.

Administrators open **System settings** at `/admin/settings`. **Check for updates**
reads the fixed project release source manually;
pre-releases are excluded. Failed checks show unknown availability, with the
check time. **Download update** verifies the platform, image and executor while
the old service runs. **Apply update** shows the service, running-task and unsaved
work risks; Cancel leaves the prepared update and current workloads unchanged.
Confirmation applies immediately, including when tasks are active.

Keep the operation ID when reconnecting. Refreshing, closing the page or losing
the Web service does not cancel accepted work. The page reconnects to the same
operation and shows installed and verified running versions, bounded sanitized
progress, and whether the update succeeded or the previous version was restored.
Members have no update or diagnostic API access. Use the standalone recovery
command above when the Web or root executor is unavailable.

## Installer output and diagnostics

The default is a Chinese completion summary, including when redirected; select
English with `--language en`. Stages,
elapsed time, real download bytes, image/dependency output and waiting messages go
to stderr. The installer does not estimate a total percentage.

Automation should pass `--non-interactive --output json` with explicit deployment
facts: stdout contains one final result, including
a structured failure with nonzero exit status. Use `--verbose` for sanitized commands
and artifact identity. Existing JSON consumers must opt in explicitly.

Each run saves sanitized stage events in a root-only directory
`/var/log/dsh-phalanx/` (0700) with a per-run JSONL file (0600). Failures show its path,
service facts, available journal excerpts and a copyable user-service diagnostic
command. Initialization links appear only in the final operator result; credentials,
keys and authorization carriers are excluded from diagnostic output and logs.

A ready service proves local readiness. Check the displayed entry port, firewall or
security group and any existing reverse proxy to confirm browser access.

For a service failure, inspect the installer error and query the installed
platform service journal by unit and UID:

```sh
sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 100
```

### Deployment CLI simulation

From the source checkout, use the standalone simulator with Python 3 on macOS
or Linux. It prints simulated output and leaves the deployment and its files
alone.

```sh
python3 scripts/install/preview.py start
python3 scripts/install/preview.py stop
python3 scripts/install/preview.py uninstall --purge
python3 scripts/install/preview.py status --state partial --output json
```

## Recover the initialization link

To retrieve the active link, or replace it and invalidate the old one, run:

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080 --renew
```

Replace the example origin with the actual browser origin. After initialization,
both commands return `/admin`; they cannot reopen first-admin creation.

### Prefill the first-model form

The deployer can supply an optional UTF-8 JSON object at
`/etc/dsh-phalanx/initial-model.json`, up to 16 KiB. Accepted fields are
`name`, `baseUrl`, `apiFormat`, `model` and `apiKey`. Use
`anthropic-messages`, `openai-completions` or `openai-responses` for
`apiFormat`. The administrator can fill in missing fields.

```json
{
  "name": "Example provider",
  "baseUrl": "https://models.example.com/v1",
  "apiFormat": "openai-completions",
  "model": "example-model",
  "apiKey": "<credential>"
}
```

Create a regular `0600` file owned by the platform runtime user, normally
`dsh-phalanx`, with traversable parent directories. The platform verifies the
owner, mode and size on the descriptor it reads. An invalid or unreadable file
leaves manual setup and skipping available. The browser shows only the preset
key status. An empty key field uses the preset value. Passing a new key replaces
it. Enter values in the file or the form and keep secrets out of URL parameters.

Saving makes PostgreSQL authoritative. Skipping leaves model settings empty.
The deployer retains ownership of this file after setup.

## Legacy service preview configuration

The service preview entry is currently unavailable. Keep existing settings. When moving or restoring an existing deployment, preserve its separate preview listener and origin with the protected configuration. The deployer retains the corresponding certificate and edge configuration.
