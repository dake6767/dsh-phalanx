# dsh-phalanx

[简体中文](README.zh-CN.md) · [Installation](docs/install.md) · [Development](docs/development.md)

dsh-phalanx hosts DeepSeek Harness (DSH) for small self-hosted teams. Each member
has a private home and workspace, native settings, plugins and model choices.
Administrators configure shared providers and a default model; members can select any enabled shared model. An
administrator manages accounts from one page. There is no public registration.

This is a **community project, not affiliated with or endorsed by DeepSeek**.
It is feedback-oriented and maintained on a low-touch basis, without a support
SLA or promised response time. See [Releases](https://github.com/dake6767/dsh-phalanx/releases)
for completed stable versions; candidate previews are selected explicitly.

## Install on Ubuntu

Supported deployment: **Ubuntu 24.04 LTS, amd64, sudo**, rootless Podman user
instances. The platform runs as a host systemd service. The installer supplies
host dependencies, a bundled Node runtime and the verified matching DSH image.
No development Node/pnpm, GitHub account, registry login or image build is needed
for a completed public stable release.

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

This selects the latest **completed stable** release, excluding previews. If no
stable release exists yet, use the documented [private candidate supply](docs/install.md#private-candidate-validation).
For 0.1.1, confirm the browser address and public IPv4 inventory. No model key is
required to install. Open the printed initialization URL, choose an administrator
username and password, and enter the management page directly. It displays the
unconfigured model state. Reinstallation preserves configuration and user data.

A fresh 0.1.1 installation listens on `0.0.0.0:18080`; confirm the reachable LAN
or public URL. HTTPS, domains and cloud security groups are deployer-managed.
See [installation](docs/install.md) for storage disks, link renewal, service
commands and the retained 0.1.0 installation behavior.

## Accounts and user spaces

Create members at `/admin` after first-admin initialization. Returning users sign
in at `/login`. Members enter native DSH at `/app/<spaceId>/`; bookmarks keep
the same address across restart. The old `/` entry redirects to that member's
space. Administrators use `/admin` and its Open DSH link. Each account has at
most one associated instance. The space ID identifies a space; HTTP and WebSocket
access still require its owner's current login.
Administrators create accounts, reset passwords, disable/enable accounts, delete
accounts and appoint administrators. Reset revokes existing sessions while
retaining the instance. Disable/delete revoke access and stop the instance;
delete preserves the retired space; reusing a username creates a new space. The last enabled administrator
cannot be disabled, deleted or demoted.

Default credentials stay in the platform, outside user spaces. Native settings,
plugins and shared-model selection remain available and survive ordinary restart. Normal personal-provider settings are disabled in 0.1.1; terminals and user plugins remain available.
The container isolates the private home/workspace and limits direct host access;
authenticated external proxy access requires the declared public host inventory.

## Develop and contribute

[Development instructions](docs/development.md) include exact pinned Node/pnpm,
an external pinned DSH build, environment setup and public-entry tests. **Process
mode is for local trusted development and provides no filesystem or network
isolation.** Mac development is distinct from Linux container verification and
clean Ubuntu installation.

See the English [architecture](docs/architecture.md), [ADRs](docs/adr/README.md)
and [CI/release contract](docs/ci-release.md). Version 0.1.0 does not provide
open registration, multiple deployment distributions, automatic upgrades or an
enterprise administration system.

Licensed under [Apache-2.0](LICENSE), with [NOTICE](NOTICE) and a
[trademark statement](TRADEMARKS.md). DSH and other external dependencies retain
their own licenses and notices.

### Member logout and recovery

The protected platform plugin supplies separate **Log out** and **Restart instance** entries in DSH. Logout clears this browser’s platform login while accepted tasks continue. Restart requires confirmation that running tasks will be interrupted; **Return to DSH** reopens the same space with configuration, user plugins, conversations and files retained.

Valid member credentials still sign in to the platform when DSH fails to start and lead directly to recovery. If DSH cannot load, open `/recovery` at your deployment origin to log out or restart and see the result. Ask an administrator to reset the DSH environment when a damaged configuration prevents restarting. The platform selects the current authenticated account as the target. The plugin files are read-only in containers and ordinary plugin management cannot disable or uninstall them. Members retain terminals and their own plugins; this protection does not promise immunity from arbitrary code interfering with their own DSH.

### Administrator environment recovery

In account management, choose **Reset DSH environment** for the enabled member and confirm that running tasks will be interrupted. This works even when the member cannot open DSH. The platform stops that member's instance, completes a private backup, resets the web profile (including installed user plugins), home patch/environment and pending legacy Settings import, then starts a replacement. The member's space URL, projects, chats and other personal files are preserved. A member with no instance can be started through this action.

Backup failure leaves the original configuration intact. Reset or startup failure reports the completed backup and restore instructions; it does not report success. Backups are retained under `environment-backups/<spaceId>/<backupId>` in the platform data root, outside member mounts. They may contain private settings and credentials. The result points the deployer to a `README.txt` and manifest describing present and absent configuration carriers. For manual restoration, stop the platform service **and verify the target container is removed**, preserve the current carriers separately, then restore only the listed originals without following symlinks. Platform shutdown alone can leave containers running. Restoring an old backup also restores its old fault. Backups are never automatically deleted.
