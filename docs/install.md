# Debian-family installation

[简体中文](install.zh-CN.md)

The installer supports Debian-family amd64 hosts with sudo access. Ubuntu 24.04
and 26.04 are verified; other family distributions are unverified. The installer
supplies host packages, a dedicated rootless Podman identity, the bundled
runtime, the verified platform package and its matching DSH image. Deployers do
not need development Node.js, pnpm, GitHub CLI or a local image build.

## Host requirements

Admission uses the host's `ID` and `ID_LIKE` distribution-family fields, followed
by capability checks. Ubuntu 24.04 and 26.04 form the verified list. Other
Debian-family hosts receive an unverified warning without another confirmation;
passing the checks does not put a distribution on that list. Non-Debian-family
hosts are refused before host changes.

The host needs Podman **4.9.3 or newer**, passt **0.0~git20240220 or newer**,
systemd with a working user manager, cgroup v2 and working rootless Podman.
The installer prepares apt packages before checking these capabilities. When
`pasta --version` cannot identify its version, the installed passt package
version is checked. Unknown or insufficient capabilities fail with diagnostics
showing the requirement and actual package versions. A failed capability check
can leave prepared OS packages; a fresh install has not yet created its product
identity or deployment configuration.

Bundle installation with `--bundle-dir` is guaranteed only on the verified
Ubuntu releases. Missing OS dependencies still require available apt sources. Other Debian-family
hosts have no offline-install guarantee. One-time distribution verification is
recorded in the [release notes](../releases/notes/).

## Member instances

In **System settings → Member instances**, set the default **CPU (cores)**, **Memory (MiB)** and **Processes** for each member container. Enter positive values; CPU can be fractional and the process count must be an integer. Leave a field blank for unlimited. New installations start with unlimited defaults. **Use suggested limits** fills in a starting point: half the host memory capped at 4 GiB, half the CPUs with at least one core, and 2048 processes. Review and save these values for your workload; suggestions are not applied automatically.

In an account's **Instance resource limits**, choose **Inherit defaults** or **Custom limits**. Custom limits replace all three default fields, including any left unlimited. Save to change the target limits; a running instance keeps its current limits until its next start or explicit application. Compare **Target limits**, **Current limits** and **Limits pending** before applying.

Use **Apply to running instances** in system settings or **Apply immediately** in account details, then confirm the affected instances. The platform updates live limits when supported and restarts an instance when live application is unavailable, interrupting its tasks. Lowering memory can terminate running processes; a finite memory limit disables swap. Review individual results after a partial failure. Capacity guidance adds target memory for running or enabled resident members, counting each once and listing unlimited targets separately. It warns about overcommit without reserving memory or blocking startup.

Resource settings are stored in the platform database. `DSH_PHALANX_CONTAINER_ARGS_JSON` is no longer accepted; remove it and use administration to configure member limits.

In **System settings → Member instances**, set idle reclamation in seconds (default 1800; 0 disables it). The deployment idle setting is imported once; later changes belong in the system settings. Development mode uses the same idle and resident behavior; container resource limits still require container mode.

In an account's details, select **Resident instance** and save. Enabled resident members start automatically after platform startup or upgrade, with at most two automatic starts at once. Entering a queued member's workspace moves it ahead in the queue. Resident instances skip idle reclamation and restart after a confirmed unexpected exit. An automatic startup failure is shown with its time; the platform does not keep retrying it. Enter the member workspace to try again.

Disabling an account stops its instance and keeps the resident setting; enabling it resumes automatic startup. Deleting the account removes that setting. Resident counts have no fixed limit. Capacity guidance counts running or resident members once and only warns about memory overcommit. **Restarting the platform interrupts tasks in resident instances.**


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

Envelope encryption protects platform secrets when database contents or database backups leak. It does not protect against a compromised platform host or a deployer who can read the master key. Database ciphertext and the matching master key together allow decryption. Member-owned keys and files remain the member's responsibility. Keep all backups private; generated projections must not contain platform provider or integration secrets.

### Master key backup

The master key is `/var/lib/dsh-phalanx/keys/master.key`; the database connection file is `/var/lib/dsh-phalanx/keys/database.json`. Back up the master key offline, separately from database backups. Also preserve the protected database connection files and deployment environment with their original permissions. The installed key and connection file are mode `0600` and belong to the service account. To verify the installed key without printing its contents:

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start master-key-fingerprint --config-file /var/lib/dsh-phalanx/keys/database.json --data-root /var/lib/dsh-phalanx/data
```

A lost master key cannot decrypt existing secrets. Secret reset clears protected platform credentials and requires sign-in and credential configuration again; it is not a backup recovery method. After key rotation, create a new offline backup and keep any previous key/configuration set required by the retained recovery operation.

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
environment-reset backups. Keep the archive with the matching deployment set
described above, and verify that it can be listed and restored with its original
ownership and permissions. An upgrade's automatic recovery is not a replacement
for this backup.

## Office preview fonts

The user-instance image includes Noto CJK (`1:20220127+repack1-1`),
Liberation 2 (`2.1.5-1`), Carlito (`20220224-1`), and Caladea (`20200211-1`)
from Debian Bookworm. These fonts use the SIL Open Font License 1.1; their
copyright and license notices remain in `/usr/share/doc/<package>/copyright`
inside the image. The official Office converter reads the system font
directories and retains its default family substitutions. Missing document
fonts still appear in the native preview notice; substitution can change layout.

Previewing never rewrites the original Office file. Restarting the instance
after an image upgrade creates a new converter generation, so reopening an
existing file uses the new fonts instead of a PDF cached by the old converter.
There is no font upload or font management page. Spreadsheet previews retain
DSH's native spreadsheet renderer.

## Downloading artifacts

Delivery cards and document preview toolbars provide **Download**. The browser
saves the current original file, including formats that cannot be previewed;
it does not save an Office preview PDF in place of its source. Chinese filenames
are preserved. Older conversation references follow the current file at that
path, without keeping historical snapshots.

Downloads require the member's current login and a valid Session. Files must
remain within that member's private home or the Session workspace and pass the
native file permissions. Missing or unreadable files show a local error. Large
files stream in bounded chunks; a file changed during transfer causes the
browser download to fail, so refresh and retry after writing has finished.

## Interactive HTML files

HTML and HTM files open with script interaction enabled, independently of **Show
coding view**. Buttons, local form events and DOM updates work in a sandboxed
preview. Reopening or reloading the file resets its in-memory state.

File previews support self-contained documents: scripts cannot read the platform
page or its login credentials. Resource loading and API requests are restricted by
a Content Security Policy; this is not a guarantee against all network navigation.
Persistent storage, external resources and application correctness are not guaranteed. Use a running HTTP service for an
application that needs a server; opening a file does not provide saved application
data or service hosting.

## Private HTTP service previews

The platform service-preview button is hidden in the DSH sidebar. Existing
authenticated preview routes remain available: open `<platform-origin>/service-preview/`
after signing in to see the service port, application path and agent instructions. Start the application
with the existing execution tools in your own instance. For port `4300`, configure
its asset, API and WebSocket base path using the exact prefix shown by the entry:
`/preview/<spaceId>/4300/<preview-credential>/`; the application
receives that full prefix. The trusted browser link is
`<platform-origin>/service-preview/<spaceId>/4300/<application-path>`.
A wrong prefix may produce a missing page or broken assets; configure the app and
reload. Redirects and Service Workers are unsupported.

A deployer must configure a separate preview listener and browser origin. For a
first installation, add `--preview-port 18081 --preview-origin
http://192.0.2.10:18081` alongside `--public-origin http://192.0.2.10:18080`.
For an existing installation, follow [service management](#service-management-and-recovery)
to set both `DSH_PHALANX_PREVIEW_PORT="18081"` and
`DSH_PHALANX_PREVIEW_ORIGIN="http://192.0.2.10:18081"` in the protected environment,
then restart. Replace the example IP with the actual deployment host. The preview
listener uses the platform's bind address. Keep its port distinct from the platform
and private gateway. Without these settings, the entry explains what is missing.

Both public origins must use the same hostname or IP and scheme, on different
ports. Pure IP HTTP works without a domain. For HTTPS, terminate TLS for both
origins with a certificate trusted by the browser and covering that hostname/IP;
forward each port to its corresponding listener while preserving Host and Origin.
The preview must also use HTTPS: certificate bypass and mixed content are not
supported. Network rules and the TLS proxy are deployer-owned. Upgrade maintenance
also fences the configured preview listener.

The signed-in member receives a random, scoped preview credential bound to that
login, space, port and running instance. The normal address-bar link does not contain
this credential. The internal iframe URL and application prefix do: keep them private,
since this is a transferable preview credential. It cannot authorize platform APIs.
After a new login or instance replacement, obtain a new prefix and reconfigure the
application. Preview applications have opaque browser origins: localStorage,
IndexedDB and cookies are unavailable, so save application data on its server.
Allowed
ports are `1024–65535`, excluding the configured platform, DSH, private gateway and
preview listener ports. Targets are container loopback services; URLs cannot select
a host, another member or an internal network destination. Platform cookies and authorization headers are
removed before forwarding. Opaque application resource/API/WS requests use the
scoped preview credential; application requests cannot issue or extend it. Preview applications cannot read the platform parent
page or borrow its authenticated HTTP/WebSocket endpoints.

Real interaction in the visible trusted preview page updates the instance's idle
activity. Background polling, an idle page, an idle WebSocket or merely running a
service process does not keep it alive. Existing native DSH connections and agent
tasks retain their normal activity rules. Logout, account revocation and instance
replacement, platform restart or login expiration revoke preview access and close its connections. After reclamation,
open the workspace and restart the application with the existing tools, then reopen
the preview. The platform does not restore arbitrary service processes or provide
public sharing or permanent hosting.

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

No model key is required. The first screen chooses Simplified Chinese or English,
with Chinese as the default; use `--language en` to select English explicitly.
Choose Official (the default), Mainland China or custom download sources before
the first release lookup. Language does not change the source. Supply the server
access IP and entry port (default 18080), then accept the suggested HTTP browser
URL or enter the actual HTTP/HTTPS domain. The URL does not configure certificates
or a reverse proxy. Bracketed values are defaults; press Enter to accept them.
Advanced gateway/storage settings are optional; invalid input stays on its
question, and the summary supports editing or cancellation.

Port forwarding/public NAT is a separate declaration, defaulting to No when
confirmed with Enter. An explicit empty `--host-public-addresses ''` means no
additional public ingress aliases; it permits normal public egress while host,
private, loopback and declared NAT targets remain protected. An undeclared
inventory continues to block member egress. The server access IP and a shared
public egress address are not substitutes for the mapping declaration.

For unattended installation, provide explicit facts and disable terminal input:

```sh
sudo bash install.sh --non-interactive --language en \
  --public-origin http://192.0.2.10:18080 --host-public-addresses '' --output json
```

Replace the example origin with the deployment's actual browser address. JSON
selects structured output; `--non-interactive` disables questions even with a
terminal. Upgrade interruption still requires its separate `--yes` confirmation.

The installer prints an `initializationUrl`. Open it in a browser, enter an
administrator username and password, and sign in automatically to the optional first-model form. Email is optional. Save one provider and one enabled default model, or choose **Skip for now and finish installation** to enter `/admin`. Only configuration format is checked; saving does not verify that the model can answer. Existing deployments are not redirected into this step.
If you skip, the management page shows the unconfigured model state; terminals and workspaces
remain available. Open Model management at `/admin/models`, choose the provider protocol, add individual model rows and save the provider explicitly. The base URL keeps the prefix that protocol expects. For Anthropic Messages, DeepSeek uses `https://api.deepseek.com/anthropic` and Volcengine Coding Plan uses `https://ark.cn-beijing.volces.com/api/coding`; the gateway appends `/v1/messages`. For OpenAI Chat Completions or OpenAI Responses, keep any version prefix the provider requires, such as `https://api.deepseek.com/v1`; the gateway appends `/chat/completions` or `/responses`. Choose a replacement default before disabling or deleting its current model or provider. Existing member catalogs update without a platform restart.

Each model row has a **Supports images** switch. Known vision models such as
`deepseek-flash` start with it enabled; other model identifiers default to text
only. Save the provider after changing it. The declaration governs image uploads,
`read_image` and subagent image input through DSH. Disabling it makes DSH reject
images before model admission. New rows use the same known-model defaults; saved declarations remain
unchanged. This switch declares upstream capability; it cannot add image support
to an upstream model that lacks it.

**Supports reasoning effort** is off by default for every model, including existing
models. Enable it only when the upstream supports selecting reasoning intensity.
This declaration exposes Off, Low, Medium and High in DSH's conversation model
picker; disabling it hides the Effort control. It does not turn the model's own
reasoning on or off. The member or provider chooses the default. The platform
passes reasoning fields through without choosing a default effort.


Configure provider credentials in administration after signup. The platform generates
its session signing key and stores both kinds of secrets encrypted in PostgreSQL;
they are not deployment environment settings. Fresh installations and formal deployments use the formal release channel by default.

Installation and CLI/Web upgrades read public release metadata and assets without a GitHub token or API access. Formal deployments use the latest completed stable release’s `release.json` pointer. Candidate deployments first check for a formal release with the same target version, then use the candidate channel’s published run pointer. A newer target version can be upgraded; another candidate build of the same target version is treated as current. Explicit versions download their metadata directly. The installer checks matching source, platform checksum, image digest and acceptance records before changing the host. If release metadata is missing or inconsistent, retry a completed version or check the GitHub asset prefix.

The root-owned installer receipt records the channel and its source address, outside PostgreSQL. Moving a candidate deployment to the same-version formal release runs the normal backup, switch, verification and commit transaction and preserves accounts and member data. The channel changes at successful commit; a failed transaction restores the previous receipt. Restoring only the database does not change the channel. There is no channel-management setting.

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

## Groups and plugins

Use **Skills → Skill catalog** and **Plugins → Plugin catalog** for reviewed entries and their dependencies. See [Skill catalog](skill-execution.md#skill-catalog) and [Plugin catalog](plugin-access.md#plugin-catalog).

Each account belongs to one group. New ordinary accounts enter the default group;
existing ordinary accounts join it during migration. Administrators belong to a
protected group with explicit plugin, skill, MCP configuration, like ordinary groups. Library management permissions come from the account role and do not depend on these grants. Assigning or revoking
an administrator role changes group membership in the same operation. Change the
default group in Group management; groups with members and the default group cannot
be deleted. Manage member membership and filter by group in Account management.

In **Plugin library → Add plugin**, enter a package name, `package@1.2.3` or
`package@latest`; scoped names such as `@scope/package` work too. A name without
a version uses `latest`. Precheck resolves it to an exact version and displays the
package name, source and checked content. Choose **Confirm and add** to put that
checked version in the library; a later change to `latest` does not change it.
Version ranges and other tags are not supported. You can also upload
a private `.tgz` archive through the separate upload action.

To add a plugin from a public GitHub repository, enter `github:owner/repo` or
`https://github.com/owner/repo`. Precheck pins the default branch to its latest
commit, downloads that commit's source and packs it in a network-disabled container
without running any repository script, including `prepare` and `prepack`. The packed
archive then goes through the same checks as an upload. The preview shows the
package name and version from the repository's `package.json` and the pinned commit;
the library shows the version as `x.y.z (abc1234)`. The repository must contain the
built files its `main`, `exports` and `dsh.bundle` entries name, because the platform
does not build plugins: a repository without them fails with a build-required error,
so use its npm package or upload a `.tgz` instead. Dependencies must come from the npm
registry, including `npm:` aliases; Git, URL and path dependencies are rejected.
Clone-style Git URLs (`git+...`, `ssh:`, `git@` and `.git` archive URLs), branches, tags, commits and other Git hosts are not supported. The platform checks
the package and its dependencies in a disposable container, then checks activation
offline. Adding a plugin neither grants it to any group nor publishes it.
Configure optional upstreams, platform credentials and access settings in the
plugin details. See [Plugin and MCP access](plugin-access.md) for setup and boundaries.

The library records where each plugin came from. A package name has one source:
npm, upload or one GitHub repository. Adding or replacing it from another source is
rejected; remove it first, then add it again from the other source. Choose **Check
for updates** in a plugin's details to compare, on demand, the library version with
npm `latest`, or the recorded commit with the GitHub default-branch head; a new
commit is reported even when the package version number did not change. The
platform never checks or updates on its own. **Precheck update** resolves the new
npm version, or packs the new commit's source through the same GitHub precheck, and
checks it as a replacement candidate; the current version stays active until you
select the candidate. Uploaded plugins are updated by uploading a replacement
archive.

Plugins added before the library recorded sources are removed by the upgrade that
introduces source records, together with their grants, member selections, plugin
settings and dependent references. Add and configure them again after upgrading. Catalog entries that
installed such a plugin keep their other items and show the plugin as detached;
uninstall the entry to remove the rest. Member files, accounts and other settings
are kept, and members' already installed copies are not removed.

The **Plugins** tab in group details has two lists:

- **Platform controlled** loads the selected library version read-only. Members cannot
  change its settings, disable it or uninstall it through plugin management. Without
  platform credentials, some plugins may have limited functionality. Grant changes
  take effect after restart; pending counts and the confirmed **Restart affected members**
  action identify running members whose configuration differs.
- **Preinstalled plugins** installs a native copy once, in the background after the instance is
  ready. Members can change settings, disable, upgrade or uninstall that copy. Removing
  it from the list, changing groups or uninstalling it does not install it again.
  Failed deliveries retry on the next instance start; the tab shows only the count
  of members with incomplete deliveries. Changing groups installs only packages
  that member has not received before. A package cannot be in both lists for one group.

Neither list is an installation allowlist: members retain native installation and
terminal access. A native copy yields to existing selected read-only access;
preinstallation still installs it once and records success. The read-only copy takes
priority until that eligibility ends and the instance restarts. Explicitly disabled
member bundles remain disabled. Preinstalled native copies receive no platform credential.

Publishing offers a checked plugin in **Platform apps** in the DSH sidebar. For an
ordinary plugin, **Install** downloads the checked archive privately, verifies and installs
it in the member's native profile. Settings persist and either Platform apps or the
native plugin page can uninstall the platform-delivered copy. Members can manage their
own upgrades on the native page. An independently installed same-name copy is shown as
**Installed on the native plugin page** and is managed there; the app center does not
replace it. Native copies have no source label.

A published plugin with a platform credential instead saves a read-only selection,
with **Platform shared KEY** shown on its card. A group-controlled plugin is marked
**Platform controlled, cannot uninstall**. Only these read-only cases use platform
credentials and entry settings. If a read-only selection coexists with a native copy,
removing the selection leaves the native copy; restart to release the read-only priority.
The page follows the DSH language setting, independently of Platform language.

Unpublishing hides the listing and clears read-only member selections; group control
remains. Installed native copies, their settings and delivery history remain, including
after restart. **Unpublishing is not a fleet uninstall; use Platform controlled when
access must be revocable.** Losing all authorization rejects the next platform upstream
call immediately; disabling an account also rejects subsequent calls.

A replacement version is checked while the current version remains selected.
Selecting the replacement shows affected group and member counts and requires
confirmation. It updates read-only loading, not versions already installed in member
profiles. Members manage native versions themselves. Upstreams and access settings survive version changes; missing entry IDs
are marked and skipped while other entries and environment variables still apply.
Removing a library plugin clears its grants, publication, selections, upstreams,
credentials and access settings; native member copies remain. After a system update, current and candidate plugins
are checked against the selected runtime before service readiness. This can extend
startup. Incompatible plugins retain grants but stop platform loading and disappear
from the marketplace. Selecting a compatible replacement restores loading and the
previous publication intent; administrators can cancel automatic republication.
If a plugin is marked incompatible, obtain a release that supports the selected DSH
runtime and check it as a replacement. The platform retains the original package
and authorization records; it does not rewrite third-party plugins or restore removed
runtime services. Native self-installed copies must be handled on the native plugin page.

System upgrades preserve platform data. Resetting a member's DSH environment clears
native plugins and platform-owned yield entries from that profile. Successful preinstall
delivery records are cleared, so the replacement instance installs once from the current
group list. Self-selected native plugins are not restored automatically. Library data,
group lists, read-only selections, upstreams, credentials and access settings remain.
Administrator and member resets follow the same rules. Back up platform plugin state
together with the account database and member storage.

## Platform app center and MCP

In administration, plugin, skill, skill-pack and MCP details begin with a **Platform
App Center** section. It shows publication separately from availability and provides
independent publish/unpublish actions with an impact confirmation. Save a new resource
first; save or discard pending edits before changing publication. Catalog content stays
read-only while its publication remains an administrator choice. Updates preserve that
choice. A plugin paused for incompatibility explains automatic republication and lets
you cancel it. Published empty or conflicting packs show why members cannot use them.
When platform credentials are involved, confirmation explains that all members may use
them through the resource. Unpublishing retains group grants; republishing does not
restore cleared self-selections. Native plugin copies remain installed, while shared-key
plugin selections stop loading after restart. Skill, pack and MCP selections are cleared
for the resource being unpublished.

Open **Platform apps** from the DSH sidebar. Its tabs are **Plugins | Skills | MCP services**, in that order. The account menu and recovery page also link
to this entry. The standalone `/market` page is unavailable; replace old bookmarks
with the DSH sidebar entry. This does not remove the native DSH plugin manager.

The **Skills** tab includes expandable skill packs alongside individual skills. Native plugin operations report whether they apply immediately or
require a restart; the platform never restarts automatically. Read-only plugin changes
require an instance restart; skill and pack changes
apply to new sessions; MCP changes refresh tools on the next agent request without a
restart. A failed tab can be retried without blocking the others.

Administrators configure MCP services, preparation, credential templates and tool
restrictions in **MCP library**, then grant services through Group management or
publish them for member selection. Follow [MCP services](plugin-access.md#mcp-services)
for run-location choices, testing, authentication limits and lifecycle behavior.
Back up MCP state with the platform PostgreSQL database. Changing the supported DSH revision
regenerates member MCP configuration and prepares command dependencies for that
runtime before those commands become available.

## Skills

In **Skill library**, upload one ZIP archive containing one or more skills, or enter a public Git source.
Review the discovered skills, their file trees and rendered `SKILL.md`, choose what
to import, and explicitly confirm same-name replacements. Administrators review
package behavior. The platform rejects unsafe archive paths, links and special
files, and warns about common secret filenames/content patterns without showing
matched values. These checks do not certify code or detect every secret.

Manual uploads and ordinary Git imports limit each skill to 20 MiB and a
multi-skill intake to 100 MiB.
Skills installed or updated from the signed catalog have separate limits:
16384 files and 128 MiB for the repository, with at most 64 MiB per skill.
A catalog entry that exceeds these limits shows a specific catalog limit error.
Path and link checks apply to both profiles; catalog provenance does not grant
larger limits to a later ordinary Git import.
A root `SKILL.md` selects one skill. Otherwise discovery searches supported skill
containers, then bounded nested directories. Frontmatter `name` uses lowercase
letters, digits and single hyphens; it identifies the skill independently of ZIP
filenames or `_meta.json`. Description is required. Runtime reserved names are
rejected. Internal skills start hidden. No dependency or script runs during import.
Configure optional [platform execution](skill-execution.md) separately.

Each discovered skill is validated independently. A skill whose `SKILL.md`
frontmatter is invalid appears under **Unable to import** with its file path, the
failing field and the reason; valid siblings remain importable in the same preview,
and a description that needs quoting for a colon is reported as such. Source-level
problems such as unsafe paths, links or special files still reject the whole
source, and a source with no valid skill keeps the original no-skills error.

### Skill packs and multi-skill imports

The **Skill packs** tab combines existing library skills with a name, description
and optional orchestration instructions. Packs do not nest or duplicate skill
files. Group grants and published member selections work for whole packs; effective
access is the union of direct and pack access, with managed access taking priority.
An orchestration skill appears only while the pack has an available child.

New packs start unpublished. Saving content preserves publication; use the independent
action in the detail's **Platform App Center** section to publish or unpublish. Empty
packs can remain published while unavailable to members; no new publication prerequisite
is imposed. Unpublishing a pack clears that pack's selections and retains its group
grants and individual skill selections.

The skill library, group grants and member skill choices show packs
as expandable entries. Packed skills remain inside their packs unless a direct
group grant or member selection also keeps them at the top level. If a member
cannot see any parent pack, an otherwise visible skill retains its individual
entry. Hidden packs and their other children are not disclosed. Expanding a visible
pack shows its children; individual installation and full skill details retain
their existing publication and direct-grant requirements. Selecting or granting a
whole pack still makes all its available children usable. Existing group
choices are preserved.

Multi-skill import lets you select an orchestration document; a document declaring
`orchestration.children` is preselected. Confirm the suggested pack name and selected
children before importing. Recognized plugin manifests can suggest packs; remaining
skills appear under **Other skills**. Cancelling the preview changes nothing.

Removing a pack normally preserves its skills. The optional delete-skills action
previews which children can be deleted: another pack or an explicit group grant
keeps a child. Direct member selections of deleted children are cleared. Removing
a child from the library also removes its pack references; an empty pack stays in
administration and disappears from member applications. Environment reset retains
pack selections. Account deletion clears that account's selections.

### Git sources and updates

Acceptable sources include `owner/repository`, a GitHub tree URL, and a public
HTTPS Git URL, optionally with a subpath and `#ref`. Private repositories, SSH,
local paths, registry APIs and embedded credentials are unsupported. Imports do not
use the administrator's Git credentials, hooks, global configuration or submodules.

The details page records the source URL, path, ref, commit and content identity.
**Check for updates** creates a review of changed, new, unchanged and removed skills.
Choose replacements and removals explicitly. Cancelling preserves the current
library; no periodic or automatic update runs. A ref change may resolve to a new
commit while unchanged skill content remains unchanged.

Git uses the [deployer egress proxy](#egress-proxy). A custom trusted CA can be supplied with `GIT_SSL_CAINFO`. The installer supplies Git and upgrade preparation installs it when missing.

Administrator and ordinary groups start with no skill grants: select **Group management → group details → Skills** to grant
skills. Importing does not grant any group access or publish the skill.
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
skill. When the administrator enables [platform execution](skill-execution.md),
configured commands use platform credentials without requiring a personal copy.

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

In Account management, the member row's **More actions** menu starts with **Switch to this member’s DSH**. It fixes the target username and requires that account's password. Errors leave the administrator signed in; Cancel returns to account management. Success opens the target DSH, including administrator targets, and preserves the original administrator in the browser's remembered accounts. A full ten-account list refuses the switch without displacing an account.

The same menu offers **Start instance** for a stopped member or **Restart instance** for a running member, immediately above environment reset. Restart requires confirmation that tasks will be interrupted and retains configuration, plugins and persistent files. Disabled accounts and instances with an operation in progress cannot be started or restarted. Refresh the page if another operator changes the state.

Members enter `/app/<spaceId>/` after login. The old root entry redirects there;
administrators retain `/admin` and its Open DSH link. The platform checks the
current account and space ownership for every HTTP and WebSocket request. DSH
cookies, plugin assets, RPC and manifest use the same mount. Configure the exact
browser-facing `--public-origin` when terminating HTTPS at an external proxy;
forward the full path and WebSocket upgrades to the platform.

## Switching accounts in this browser

Administrators see **Go to admin console** as the first item in the DSH sidebar
account menu. It opens the same deployment's `/admin` home in a new tab and keeps
DSH open. Ordinary members do not see this item. Refresh DSH after a role change
to update the menu; management pages always check the current permission.

Choose **Switch accounts** in the DSH sidebar account menu or the management
sidebar account area. The recovery page at `/recovery` also lists accounts,
even when DSH cannot start. Select an available account to enter its default
page: management for administrators, DSH for members.

- **Add account** opens the login page. Sign in once with that account's username
  and password to remember it in this browser. Canceling or failing login keeps
  the current account. The browser remembers at most ten accounts; remove one
  before adding another when full. Signing in to an existing entry updates it.
- **Remove** forgets an entry in this browser; it does not delete the platform
  account. For available entries, open the row's more-actions menu. Unavailable
  entries show **Remove** directly and cannot be selected.
- **Sign out** ends the current browser login and keeps its entry as **Sign in
  again**. The login page offers other available accounts; **Use another
  account** opens the login form. **Sign out of all accounts** clears the
  remembered list and the current browser login.

Each login still lasts twelve hours. Switching does not renew it. Expired or
revoked sessions require a password again; disabled or deleted accounts are
unavailable. Recreating a deleted username does not reconnect its old entry.
The list belongs to this browser and does not synchronize across devices.

One browser has one current account. After a switch, other open tabs display
a blocking account-change notice and disconnect their old live connections.
Choose **Go** to enter the current account. Different tabs cannot remain active
as different accounts.

**Switching accounts clears DSH's local browser storage without confirmation.**
Unsent messages, unfinished answers to agent questions, custom shortcuts,
sidebar layout, manual conversation ordering, and editor and shell preferences
are lost. Running tasks, agent questions and saved conversations remain in the
account's instance; switch back to continue. The platform's **System**, **Light**
or **Dark** appearance preference survives switching. This browser preference
is independent of DSH's theme.

## Entry and durable state

The platform supports English and Simplified Chinese. Choose **Platform language** beside Appearance in the admin navigation or on the sign-in, initialization and instance recovery pages. **System** follows the browser language; an explicit choice is saved in a browser cookie and survives sign-out. It is not an account setting and is independent of the language selected inside DSH. Installer, CLI and diagnostic output remain in English.

A fresh installation listens on `0.0.0.0:18080`. Confirm or override the
proposed LAN/public URL; the installer does not discover a cloud NAT address
reliably, open security-group ports, register a domain or configure certificates.
HTTP is supported. A [public HTTPS proxy](#https-on-a-custom-port) is deployer-managed.
`--listen-address`, `--port` and `--public-origin` select deployment facts on first
installation. For a loopback deployment, forward the port through SSH and supply
the corresponding browser origin explicitly.

Deployers may optionally prefill the first-model form with `/etc/dsh-phalanx/initial-model.json`, a UTF-8 JSON object of at most 16 KiB. Accepted fields are `name` (provider name), `baseUrl`, `apiFormat` (`anthropic-messages`, `openai-completions` or `openai-responses`), `model` (upstream identifier) and `apiKey`. Every field is optional; the administrator fills missing values. For example:

```json
{
  "name": "Example provider",
  "baseUrl": "https://models.example.com/v1",
  "apiFormat": "openai-completions",
  "model": "example-model",
  "apiKey": "<credential>"
}
```

The file may contain a real key. Make it a regular file, mode `0600`, owned by the platform service's runtime user (normally `dsh-phalanx`), with parent directories that user can traverse. Root ownership alone is insufficient. The platform checks ownership, mode and size on the same descriptor it reads; symlinks and special files are refused. Missing files leave a blank form. Invalid or unreadable files show a safe notice and allow manual configuration or skipping. The browser receives only a preset/masked key status: leaving the key field empty keeps the server-side value, while entering a key replaces it. Other suggestions remain editable. Never pass defaults or keys through URL parameters.

Saving makes the database configuration authoritative; the file does not continuously override it. Skipping imports nothing. The platform never deletes this deployer-managed file. If runtime publication fails after the database commits, reload the first-model page and choose **Retry model publication**; the saved provider and revision are reused. Further configuration belongs in Model management, with no automatic setup resumption on later sign-in.

The initialization link expires after 24 hours and survives ordinary service
restart. Successful account creation consumes it and signs the administrator in.
It contains a secret in the URL fragment: share it only with the first administrator.
The installer prints it but does not persist it in its installation receipt.


After the link is verified, choose **Platform database** before creating the
administrator. Keep **Built-in PostgreSQL** for the default installation, or
choose **External PostgreSQL** and enter its host, port, database, account,
password and TLS mode. The external server must run PostgreSQL 14 or newer. Its
account must own `dsh_phalanx`, or have permission to create that schema in the
selected database. Use an empty schema or the matching platform database;
unrelated objects are refused. **Test connection** reports connection, version,
ownership and schema checks in order. Test successfully before continuing.

`require` encrypts the connection without verifying the server certificate.
`verify-full` also verifies the certificate and hostname; upload or paste a CA
certificate when the server uses a private CA. `disable` uses an unencrypted
connection. A failed TLS connection never falls back to plaintext automatically.
After confirmation, accounts, usage records and protected integration configuration
use the selected database. The local
connection file and master-key file remain outside platform data with mode 0600;
the connection password is encrypted with that master key. Preserve the matching
files when restoring a deployment. Selection survives service restart. Another
running platform cannot share this database: deployment identity and a held
session lock prevent concurrent owners. A lost ownership connection stops the
platform; check database availability and restart the service.

To retrieve the active link, or replace it and invalidate the old one, run:

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080 --renew
```

Replace the example origin with the actual browser origin. After initialization,
both commands return `/admin`; they cannot reopen first-admin creation.

The installer owns `/opt/dsh-phalanx/releases` and its `current` link. Protected
deployment configuration lives in `/etc/dsh-phalanx/environment`. Accounts use
the selected platform database. Private user files default to
`/var/lib/dsh-phalanx/data`. The `dsh-phalanx`
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
Application profiles already blocked by stale locks require the application's
own recovery procedure; the platform does not remove locks from member files.
Account deletion also
preserves files. See the deployment uninstall procedure above for local data removal.

For a failed installation, retain configuration/data, inspect the named failure,
correct network/dependency/port problems and rerun the same verified version.
An archive hash mismatch must be repaired by obtaining the original matching
assets; never edit the checksum inventory. Automatic rollback applies to failed
activation. An intentional rollback requires the previous completed release and
matching image/configuration and the consistent backup taken before upgrade.
Automatic reverse migration of data written by a newer DSH is not provided.

## Configuration and supported scope

The first-run flags are shown by `bash install.sh --help`: language, noninteractive
input, download sources, server access IP, public mapping declaration, listener,
entry port, exact browser origin and internal gateway/storage settings. The
backend defaults to `0.0.0.0:18080`, gateway loopback 3081 and container mode.
Configure models in administration after initialization. `--gateway-port` changes
the internal port, not its bind address. Behind HTTPS set the exact browser origin
including its external port. An explicit empty mapping declaration permits public
egress; known host/private/loopback targets and declared aliases remain denied.
Missing declarations fail external proxy access closed.


This installer supports Debian-family amd64 hosts subject to the [host requirements](#host-requirements). Mac process development
is documented in [the contribution guide](../CONTRIBUTING.md) and has no container isolation guarantee.
Linux tests prove container behavior; existing Linux servers do not establish a
clean-install result. This project has no public registration, automatic updater
or support SLA. Candidate validation and ordinary CI
are separate from completed public release acceptance.

### Member logout and recovery

The protected platform plugin supplies **Log out**, **Restart instance** and **More recovery options** in DSH’s sidebar account menu. Logout clears this browser’s platform login while accepted tasks continue. Restart requires confirmation that running tasks will be interrupted; **Return to DSH** reopens the same space with configuration, user plugins, conversations and files retained.

Valid member credentials still sign in to the platform when DSH fails to start and lead directly to recovery. If DSH cannot load, open `/recovery` at your deployment origin to log out or restart and see the result. Use **More recovery options** to open the same recovery page from the account menu. Its **Reset DSH environment** section backs up and resets your DSH configuration and self-installed plugins, while preserving projects, conversations and other personal files. Confirm that tasks will be interrupted and those settings will be reset. Member requests are limited to once every ten minutes, including failed attempts and across platform restarts; administrators are exempt. Contact an administrator to recover an older configuration. The platform selects the current authenticated account as the target. The protected platform plugin and controlled or shared-credential read-only plugins cannot be disabled or uninstalled through ordinary plugin management. Native member copies remain manageable. Members retain terminals and their own plugins; this protection does not promise immunity from arbitrary code interfering with their own DSH.

### Administrator environment recovery

In account management, choose **Reset DSH environment** for the enabled member and confirm that running tasks will be interrupted. This works even when the member cannot open DSH. The platform stops that member's instance, completes a private backup, resets the web profile (including installed user plugins), home patch/environment and pending legacy Settings import, then starts a replacement. The member's space URL, projects, chats and other personal files are preserved. A member with no instance can be started through this action.

Backup failure leaves the original configuration intact. Reset or startup failure reports the completed backup and restore instructions; it does not report success. Backups are retained under `<userDataRoot>/_environment-backups/<spaceId>/<backupId>` on the user-space volume, outside member container mounts. They may contain private settings and credentials. The result points the deployer to a `README.txt` and manifest describing present and absent configuration carriers. The manifest identifies the home relative to the user root; after a volume move, resolve the recovery instructions against the current configured user root. For manual restoration, stop the platform service **and verify the target container is removed**, preserve the current carriers separately, then restore only the listed originals without following symlinks. Platform shutdown alone can leave containers running. Restoring an old backup also restores its old fault. After a new complete backup is published, the platform keeps the latest three complete backups per member across administrator and member requests. Only verified backups in that platform space are eligible; unknown, linked or incomplete directories remain. Cleanup failures are logged without blocking the reset. Account details show the time and initiator of the latest reset request.

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


<span id="usage-records"></span>

## CLI simulation

Before trying the planned installation and deployment commands, rehearse them
from a source checkout with Python 3. This standalone preview works on macOS
and Linux; it does not make macOS a supported installation host.

```sh
python3 scripts/install/preview.py
python3 scripts/install/preview.py --language en
python3 scripts/install/preview.py stop
python3 scripts/install/preview.py uninstall --purge
python3 scripts/install/preview.py status --state partial --output json
```

The preview never downloads artifacts, changes system settings, operates real
services, deletes files or requests credentials. All progress and results are
simulated. Select the language first, then the independent download source;
choose `custom` to set a base preset and per-category URL overrides before the
first version lookup. Explicit overrides take precedence and survive a base
preset change. Enter `cancel` at any question to leave. The summary offers `edit` before
`install`. Advanced settings rehearse the internal gateway and member storage.
An HTTPS browser URL assumes your certificate and reverse proxy already exist.
Values in square brackets are defaults; press Enter to accept them. The port
forwarding/public NAT question defaults to `none`, confirmed by pressing Enter;
choose `list` if public traffic is forwarded to this server. Noninteractive
input still requires an explicit mapping declaration.
An explicit `none` mapping declaration differs from `undeclared`; the latter
continues to block member egress.

For noninteractive rehearsal, use `--server-ip 192.0.2.10
--host-public-addresses '' --non-interactive`; `--output json` also selects
noninteractive input and produces one JSON result with `simulation: true` and
`changed: false`. `--help --output json` lists the preview's options as JSON.
Use `--fail-stage lookup|prepare|download|deploy|ready` to rehearse installation
failures, or `--fail-stage operation` for management partial failure. Retry by
removing that option. Management accepts `--state` to rehearse observed states;
noninteractive stop/uninstall require `--yes`. None of these flags affect the
real installer. The installed command and standalone installer support the retained-data procedure described above.

The simulation has no real host adapter. Its questions, input validation, source
selection, summary and project introduction share the installer question module.
Lifecycle execution remains simulated; its real implementation must keep failure
and retained-data instructions aligned with these public terminal contracts. Preview success is not evidence of a real installation.
