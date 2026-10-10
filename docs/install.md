# Ubuntu installation

[简体中文](install.zh-CN.md)

The supported host is Ubuntu 24.04 LTS amd64 with sudo access. The installer
supplies host packages, a dedicated rootless Podman identity, the bundled
runtime, the verified platform package and its matching DSH image. Deployers do
not need development Node.js, pnpm, GitHub CLI or a local image build.

## Public release path

See [Releases](https://github.com/dake6767/dsh-phalanx/releases) for completed stable versions:

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

The default resolves GitHub’s latest completed stable Release and excludes previews.
To select a version explicitly, run `sudo bash install.sh --version vX.Y.Z`.
If `curl` is absent, install it with `sudo apt-get update && sudo apt-get install -y curl`,
or download the standalone script through a browser and transfer it to the host.
The platform package and image digest come from the same Release manifest;
checksums, tag commit and image identity must agree. The image is pulled from
`ghcr.io/dake6767/dsh-phalanx` by digest. Installation does not register an
automatic updater. Anonymous public download and pull are verified at release.

No model key is required. Confirm the proposed browser address (or
supply `--public-origin`) and the complete public IPv4 inventory, including NAT
aliases. Submit an empty inventory only when the host has no public IPv4 addresses.
The installer prints an `initializationUrl`. Open it in a browser, enter an
administrator username and password, and go directly to `/admin`. Email is optional.
The management page shows the unconfigured model state; terminals and workspaces
remain available. Open Model management at `/admin/models`, add individual model rows and save the provider explicitly. The Messages Base URL includes the provider prefix: `https://api.deepseek.com/anthropic` for DeepSeek or `https://ark.cn-beijing.volces.com/api/coding` for Volcengine Coding Plan. The gateway appends `/v1/messages`. Choose a replacement default before disabling or deleting its current model or provider. Existing member catalogs update without a platform restart.

Existing static-provider deployments can still supply `--model-key-file /path/to/key`;
use a protected regular file with mode 0600. The default `latest` never selects a candidate preview.

## Groups and plugins

Each account belongs to one group. New ordinary accounts enter the default group;
existing ordinary accounts join it during migration. Administrators belong to a
protected group that receives all available library plugins. Assigning or revoking
an administrator role changes group membership in the same operation. Change the
default group in Group management; groups with members and the default group cannot
be deleted. Manage member membership and filter by group in Account management.

In Plugin library, add an npm package with an exact version or upload a private
`.tgz` archive. The platform checks the package and its dependencies in a disposable
container, then checks activation offline. Tags, version ranges and Git sources are
not supported. Adding a plugin neither grants it to ordinary groups nor publishes
it. Configure optional upstreams, platform credentials and access settings in the
plugin details. See [Plugin access](plugin-access.md) for setup and boundaries.

Group details control platform preinstallation. Granting, revoking, changing group
or selecting a different version changes loading on the member's next instance restart.
Pending counts identify running members with changes; **Restart affected members**
requires confirmation because it interrupts their tasks. Platform apps load read-only.
Group grants are not an installation allowlist: members retain native installation
and terminal access. A same-name self-installed copy yields to the platform version;
its files remain and load again when platform eligibility ends and the instance restarts.

Publishing makes the checked current version available to all members in **Platform apps**,
an entry in the DSH sidebar. Installing saves a selection; restarting loads the app
read-only at the version selected by the administrator. Members uninstall their selections
in Platform apps. Group preinstallation cannot be uninstalled by members.
Unpublishing removes the listing and member selections; group grants remain.
Loading changes after restart, but losing all authorization immediately rejects the
next upstream call. Disabling an account also rejects subsequent calls.
The page follows the DSH language setting, independently of Platform language.

The native plugin page is unchanged. Platform entries are not guaranteed native cards
or detail pages. Existing native copies remain native installations, shown as
**Installed on the native plugin page**. To switch one to a platform selection, back up
its settings as appropriate, uninstall it on the native page, then install it in Platform
apps and restart.

A replacement version is checked while the current version remains selected.
Selecting the replacement shows affected group and member counts and requires
confirmation. Upstreams and access settings survive version changes; missing entry IDs
are marked and skipped while other entries and environment variables still apply.
Removing a library plugin clears its grants, publication, selections, upstreams,
credentials and access settings; native member copies remain. After a system update, current and candidate plugins
are checked against the selected runtime before service readiness. This can extend
startup. Incompatible plugins retain grants but stop platform loading and disappear
from the marketplace. Selecting a compatible replacement restores loading and the
previous publication intent; administrators can cancel automatic republication.

System upgrades preserve platform data. Resetting a member's DSH environment clears
native self-installed plugins and platform-owned yield entries from that member's profile.
The library, group grants, selections, upstreams, credentials and access settings remain.
The replacement instance loads platform apps from that retained state. Back up platform
plugin state together with the account database and member storage.

## Skills

In **Skill library**, upload one `.zip`, review its file tree and rendered `SKILL.md`,
then confirm the import. Skills can execute scripts with the member's permissions.
Administrators are responsible for reviewing the package; the platform validates
archive structure, but does not scan code or secrets, install dependencies, or test
scripts. Do not include credentials in shared archives.

The ZIP and its extracted files must each fit within 20 MiB. Place exactly one
`SKILL.md` at the root, or put the entire skill in one top-level directory. Links,
special files and unsafe paths are rejected. The frontmatter `name` uses lowercase
letters, digits and single hyphens; this name identifies the skill throughout the
interface, regardless of the archive filename or `_meta.json`. The description
must be nonempty. A name reserved by the selected DSH runtime cannot be imported.
Importing the same name previews a replacement of its current version.

Administrators automatically receive all available library skills. Ordinary groups
start with none: select **Group management → group details → Skills** to grant
skills. Importing does not grant ordinary groups access or publish the skill.
Publish it from the skill details to offer it to everyone in **Platform apps → Skills**.
Members install and uninstall their own selections there. Group-granted skills show
as platform preinstalled and cannot be uninstalled by members. Unpublishing clears
member selections while retaining group grants; republishing does not restore selections.
Removing a skill clears both grants and selections.

Platform skill files are read-only in member containers. Changes apply to new DSH
sessions without restarting the instance. Replacement, revocation, unpublication
or removal can make a running task fail; confirmation dialogs show affected member
counts. Previous versions are not retained. If synchronization fails, the management
page reports it and provides **Retry skill synchronization**. Retry reapplies the
saved desired state.

Members may keep their own skills under `~/.dsh/skills` or `~/.agents/skills`.
Their same-name skill takes precedence over the platform copy; Platform apps shows
an override notice when a same-name top-level directory is present. The platform
neither edits nor removes those files. This differs from managed plugins, where
the platform copy takes precedence. Revoking a platform skill cannot revoke a
member's own copy. Resetting the DSH environment preserves managed, selected and
member-owned skills; skills are outside that reset backup. Disabling an account
stops distribution; deleting it removes its platform skill projection and selections.
If a runtime update introduces a bundled skill with the same name, the library
retains the package, displays the conflict and stops distributing it.

### Personal skill keys

Configure a third-party key in a private file in your own space, outside DSH's
resettable configuration files. Create it in your terminal with mode `0600`; do not
paste a real key into a conversation or shared archive. For example, store
`EXAMPLE_API_KEY='your-personal-key'` in `~/.config/my-skill/secrets.env`.
Your scripts can read this personal file.

DSH does not automatically pass parent variables whose names contain `KEY` to its
bash tool. Merely saving `.env` or a DSH credential is insufficient. Explicitly
load the private file **inside each DSH bash invocation**, then execute the script
relative to the resource directory returned when loading the skill:

```sh
set -a
. "$HOME/.config/my-skill/secrets.env"
set +a
cd /path/returned/when/loading/the/skill
python3 scripts/example.py
```

Replace the variable name, resource path and arguments with those required by the
skill. Platform credentials currently apply only to plugins. Platform execution
for skills is planned for a later version; it is not available in this release.

## Separate user storage

The system service keeps platform data at `/var/lib/dsh-phalanx/data` and defaults
user storage to its `users` directory. For a new deployment on a separate disk,
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

Platform-side `user-storage-identity` holds a persistent random platform identity;
`user-storage.json` and volume-side `.dsh-phalanx-storage.json` bind the volume to it.
Restore these files with the account database: recreating platform data at the same
path cannot adopt an existing user volume. Missing or incorrect mounts, ownership and write permissions fail
closed; do not edit or remove those files to bypass a failure. Restore mounts before
the service starts. Both home and workspace follow the user root while container
paths stay stable. Platform accounts and provider credentials remain outside member
mounts. Existing directories retain their durable mappings. Changing storage on an
existing deployment requires an explicit migration; editing or removing the variable
does not move data. Back up both roots, configuration and permissions together.

The management API exposes a persistent opaque `spaceId`. Recreating a deleted
username creates a different space and does not restore its files, sessions or model
access credentials. Upgrading the session format requires signing in again.

Members enter `/app/<spaceId>/` after login. The old root entry redirects there;
administrators retain `/admin` and its Open DSH link. The platform checks the
current account and space ownership for every HTTP and WebSocket request. DSH
cookies, plugin assets, RPC and manifest use the same mount. Configure the exact
browser-facing `--public-origin` when terminating HTTPS at an external proxy;
forward the full path and WebSocket upgrades to the platform.

## Entry and durable state

The platform supports English and Simplified Chinese. Choose **Platform language** beside Appearance in the admin navigation or on the sign-in, initialization and instance recovery pages. **System** follows the browser language; an explicit choice is saved in a browser cookie and survives sign-out. It is not an account setting and is independent of the language selected inside DSH. Installer, CLI and diagnostic output remain in English.

A fresh installation listens on `0.0.0.0:18080`. Confirm or override the
proposed LAN/public URL; the installer does not discover a cloud NAT address
reliably, open security-group ports, register a domain or configure certificates.
HTTP is supported. A [public HTTPS proxy](#https-on-a-custom-port) is deployer-managed.
`--listen-address`, `--port` and `--public-origin` select deployment facts on first
installation. For a loopback deployment, forward the port through SSH and supply
the corresponding browser origin explicitly.

The initialization link expires after 24 hours and survives ordinary service
restart. Successful account creation consumes it and signs the administrator in.
It contains a secret in the URL fragment: share it only with the first administrator.
The installer prints it but does not persist it in its installation receipt.
To retrieve the active link, or replace it and invalidate the old one, run:

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080 --renew
```

Replace the example origin with the actual browser origin. After initialization,
both commands return `/admin`; they cannot reopen first-admin creation.

The installer owns `/opt/dsh-phalanx/releases` and its `current` link. Protected
deployment configuration lives in `/etc/dsh-phalanx/environment`. Accounts and
private user files live under `/var/lib/dsh-phalanx/data`. The `dsh-phalanx`
service account runs the platform and rootless containers, with a user systemd
unit and linger enabled so it starts after reboot without an interactive login.
AppArmor remains enabled; compatibility profiles are limited to Podman and pasta.

The installer confirms the browser URL and entry port, displays data directories,
and offers advanced gateway/storage settings. Without a terminal, provide
`--public-origin URL --host-public-addresses COMPLETE_LIST` (use an empty list only
when there are no public aliases). Missing or invalid facts fail before large downloads.

After a first failed installation, rerun the wizard or supply corrected flags such as
`--gateway-port 41081`. The installer shows changed field names, preserves deployment
secrets and user files, and reuses checksum-verified downloads. No manual configuration
edit is needed for this retry. After successful installation, the same healthy version
and configuration return the existing entry without redeployment or service restart.
Conflicting configuration flags on successful installations fail explicitly; use
deliberate offline configuration/storage maintenance for those changes. A checksum or dependency failure exits nonzero.
Failed release activation restores the previous release when one exists. Do not
delete the data root to retry installation.

For a service failure, inspect the installer error and the service journal:

```sh
sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 100
```

## HTTPS on a custom port

Run a dedicated reverse proxy in front of the installed platform. The supplied
[nginx configuration](../deploy/nginx/https.conf.example) and
[systemd unit](../deploy/nginx/dsh-phalanx-edge.service.example) use an independent
`dsh-phalanx-edge` identity and process, leaving other nginx services alone.
NGINX 1.24 or later is supported by these explicit HTTP/1.1 WebSocket settings.

Before configuring TLS, verify that your chosen external port can reach a
short-lived listener on the server. Configure the platform with a loopback
listener and its exact public HTTPS origin, including the port. Select a private
gateway port that is free on the existing host (default3081):

```sh
sudo bash install.sh --version vX.Y.Z \
  --host-public-addresses 198.51.100.10 \
  --listen-address 127.0.0.1 --port 18080 --gateway-port 41081 \
  --public-origin https://198.51.100.10:18443
```

Replace the example address with the complete inventory of your server's public
IPv4 addresses. Supply the platform and matching image from the same verified
release. Existing protected platform configuration must be edited explicitly;
the installer refuses to silently replace deployment facts on repetition.

Create the edge identity with a locked password and no login shell. Install a
certificate with a Subject Alternative Name covering the exact IP (or DNS name)
used by the browser. Store its private key outside the repository, readable only
by the edge identity. Render the example paths/address, install the dedicated
configuration and unit, then validate with `nginx -t` before enabling the unit.
The unit supplies its own writable runtime directory and graceful shutdown.

For a private test CA, import the **public CA certificate** into each tester's
trust store, verifying its fingerprint through the deployment channel. Keep the
CA signing key on the deployment workstation. Certificate dates, chain and IP
matching must validate normally; browser acceptance must leave
`ignoreHTTPSErrors` disabled. Remove the specific test CA trust when the preview
ends. A public deployment should use a normally trusted certificate and its
own renewal procedure; this template does not obtain or renew certificates.

The proxy preserves the incoming Host including its port and forwards Upgrade
and Connection for WSS. Response buffering is disabled for streaming. The
platform's public origin controls relative login redirects and Secure cookies;
the backend stays HTTP on loopback. Keep the model gateway and all container
published ports on loopback too. Port 18080 in this setup is local debugging
only; the external product entry is HTTPS on 18443.

Verify browser bootstrap/login, account management, native streaming and actual
WSS frames using the trusted entry. Check externally that backend/gateway and
instance ports cannot be reached. The opt-in `tests/https-preview.e2e.ts` uses a
private access file and leaves the deployment administrator in place; it
removes only its test member through the public management API.

To stop this preview, stop and disable only `dsh-phalanx-edge.service` and the
installer-owned user's `dsh-phalanx.service`. Preserve user data/configuration.
Remove only this unit/configuration/certificate and its runtime directory when
retiring it. Restart or rollback the installed platform using its recorded
release/configuration; do not restart shared nginx or prune other identities'
containers.

References: [NGINX WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
and [Host forwarding](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

## Private candidate validation

While the repository and registry are private, a release owner supplies the
standalone installer plus the original `manifest.json`, `SHA256SUMS`, platform
archive and OCI archive from one candidate Release. Transfer them through the
authorized private channel. No deployer GitHub token is embedded in the script.

```sh
sudo bash install.sh --version vX.Y.Z-rc.N --bundle-dir /path/to/candidate
```

Replace `N` with the exact candidate number. The installer verifies both complete
archives and imports the OCI image into its own rootless storage. An unrelated
preloaded image cannot stand in for this supply step. This explicit archive
handoff is for private validation; the public release path downloads the package
and pulls the matching digest anonymously.

Use `--gateway-port PORT` to choose an unused private model/network gateway port
on an existing host. The default is 3081; during the first installation only, an occupied default can
be replaced by an available port, reported and saved. Explicit choices and saved
ports are never silently changed. The listener always remains loopback.
Reinstallation preserves that protected setting and refuses a conflicting option.

## Service management and recovery

Run these commands on the Ubuntu host. They operate only on the installer's user service:

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
then restart this service. Preserve its ownership and0640 mode. The configuration
contains shared model and session credentials; do not paste it into issue reports.
Stop the service before a consistent backup and preserve both protected config
and `/var/lib/dsh-phalanx/data`, with original permissions. Ordinary restart
rebuilds owned containers and keeps native profiles/files. Account deletion also
preserves files; data erasure and disaster recovery automation are not supplied.

For a failed installation, retain configuration/data, inspect the named failure,
correct network/dependency/port problems and rerun the same verified version.
An archive hash mismatch must be repaired by obtaining the original matching
assets; never edit the checksum inventory. Automatic rollback applies to failed
activation. An intentional rollback requires the previous completed release and
matching image/configuration and the consistent backup taken before upgrade.
Automatic reverse migration of data written by a newer DSH is not provided.

## Configuration and supported scope

The first-run flags are shown by `bash install.sh --help`: upstream URL/provider/model,
protected key file, public IPv4 inventory, listener/port, exact public origin and
private gateway port. Defaults are DeepSeek official `deepseek-chat`, backend
`0.0.0.0:18080`, gateway loopback3081 and container mode. `--gateway-port` changes
the private port, not its bind address. Behind HTTPS set the exact public origin
including its external port. A complete public IPv4 inventory prevents user
proxies from reaching declared host aliases; missing facts close external proxy access.

Only Ubuntu 24.04 LTS amd64 is supported by this installer. Mac process development
is documented in [the contribution guide](../CONTRIBUTING.md) and has no container isolation guarantee.
Linux tests prove container behavior; existing Linux servers do not establish a
clean-install result. This project has no public registration, automatic updater,
multiple host distributions or support SLA. Candidate validation and ordinary CI
are separate from completed public release acceptance.

### Member logout and recovery

The protected platform plugin supplies **Log out** and **Restart instance** in DSH’s sidebar account menu. Logout clears this browser’s platform login while accepted tasks continue. Restart requires confirmation that running tasks will be interrupted; **Return to DSH** reopens the same space with configuration, user plugins, conversations and files retained.

Valid member credentials still sign in to the platform when DSH fails to start and lead directly to recovery. If DSH cannot load, open `/recovery` at your deployment origin to log out or restart and see the result. Ask an administrator to reset the DSH environment when a damaged configuration prevents restarting. The platform selects the current authenticated account as the target. The plugin files are read-only in containers and ordinary plugin management cannot disable or uninstall them. Members retain terminals and their own plugins; this protection does not promise immunity from arbitrary code interfering with their own DSH.

### Administrator environment recovery

In account management, choose **Reset DSH environment** for the enabled member and confirm that running tasks will be interrupted. This works even when the member cannot open DSH. The platform stops that member's instance, completes a private backup, resets the web profile (including installed user plugins), home patch/environment and pending legacy Settings import, then starts a replacement. The member's space URL, projects, chats and other personal files are preserved. A member with no instance can be started through this action.

Backup failure leaves the original configuration intact. Reset or startup failure reports the completed backup and restore instructions; it does not report success. Backups are retained under `environment-backups/<spaceId>/<backupId>` in the platform data root, outside member mounts. They may contain private settings and credentials. The result points the deployer to a `README.txt` and manifest describing present and absent configuration carriers. For manual restoration, stop the platform service **and verify the target container is removed**, preserve the current carriers separately, then restore only the listed originals without following symlinks. Platform shutdown alone can leave containers running. Restoring an old backup also restores its old fault. Backups are never automatically deleted.

## Move user storage to another mounted volume

This is an explicit offline operation on Ubuntu container deployments. Prepare
and mount the new volume yourself; the tool never formats a disk. Configure its
persistent mount in the host's normal boot configuration and verify it is mounted.
Create a private parent directory below that mount, owned by `dsh-phalanx` with mode0700, then an empty target directory with the same ownership/mode inside it. The tool stages its copy beside that target.
Do not choose the mount point itself or overlap the platform or source user root.
Keep enough free space for a complete copy. The source remains intact.

1. Stop the user service with the service command above. Save a private copy of
   `/etc/dsh-phalanx/environment` before editing it, and back up platform state.
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

A private JSON receipt and `README.txt` under `storage-migrations/` record the source,
target, prior binding and recovery steps. Copy/verification failure leaves the old
binding authoritative. Keep the service stopped and the original environment to
retry the identical command. A published binding with old configuration fails
closed until configuration is explicitly switched; it never substitutes an empty
home. Interrupted publication resumes by checking the copied destination against
the retained source. A completed retry validates the volume and never overwrites
new destination changes. Linked parents, special files, wrong ownership, missing
mounts and unwritable roots are rejected. Correct the named obstruction explicitly.

For rollback, stop the platform **and confirm its owned user containers are removed**;
shutdown alone can leave them running. Retain destination changes made after cutover
and reconcile them before returning to the source. Restore the original protected
environment and the receipt's `previousBinding` (or remove only `user-storage.json`
when it was originally absent). Preserve `user-storage-identity`, both copies and
the receipt. Restore the source mount if it was external, then restart and verify
its original files before reopening access. Follow the receipt's private README;
do not remove a binding merely to bypass a missing-disk error.

## Installer output and diagnostics

The default is an English completion summary, including when redirected. Stages,
elapsed time, real download bytes, image/dependency output and waiting messages go
to stderr. The installer does not estimate a total percentage.

Automation must pass `--output json`: stdout contains one final result, including
a structured failure with nonzero exit status. Use `--verbose` for sanitized commands
and artifact identity. Existing JSON consumers must opt in explicitly.

Each run saves sanitized stage events in a root-only directory
`/var/log/dsh-phalanx/` (0700) with a per-run JSONL file (0600). Failures show its path,
service facts, available journal excerpts and a copyable user-service diagnostic
command. Initialization links appear only in the final operator result; credentials,
keys and authorization carriers are excluded from diagnostic output and logs.

A ready service proves local readiness. Check the displayed entry port, firewall or
security group and any existing reverse proxy to confirm browser access.


## Recoverable system updates

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

Protocol 1 supports platform persistence migration with verified restoration and
requires unchanged DSH revision and user-environment epoch. Unknown protocols,
unsupported source schemas or delayed native environment changes are rejected
before switching. It does not provide arbitrary historical downgrade or copy all
member project volumes. See [the compatibility and backup decision](architecture.md#system-update-transaction).

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

## Installer progress

Interactive terminals retain completed stages and refresh the current action
in place. Redirected or limited terminals use concise appended records and
infrequent waiting updates, without cursor escape sequences. Known download
totals show quantity and percentage; unknown totals show available quantity or
elapsed time. Phase time and total time are labeled separately.

Detailed sanitized diagnostics remain in the printed restricted log path;
`--verbose` shows subprocess detail. `--output json` keeps one final JSON value
on stdout and sends progress to stderr. A failure reports its cause, next step
and diagnostic path. These display changes do not alter confirmation, supported
upgrade recovery or the selected release identity.
