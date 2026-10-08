# dsh-phalanx

[简体中文](README.zh-CN.md) · [Installation](docs/install.md) · [Development](CONTRIBUTING.md)

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
Confirm the browser address and public IPv4 inventory. No model key is
required to install. Open the printed initialization URL, choose an administrator
username and password, and enter the management page directly. It displays the
unconfigured model state. Reinstallation preserves configuration and user data.

A fresh installation listens on `0.0.0.0:18080`; confirm the reachable LAN
or public URL. HTTPS, domains and cloud security groups are deployer-managed.
See [installation](docs/install.md) for storage disks, link renewal, service
commands and recovery procedures.

## System updates

Administrators check compatible formal releases, download and verify an update while the service runs, and confirm application in **System settings** at `/admin/settings`. Application immediately restarts the platform and stops user instances;
instances start again when members re-enter. Running tasks are interrupted and
unsaved work may be lost. The independent root executor records the
operation, verifies readiness and restores the previous service on supported
failures. See [system updates and emergency recovery](docs/install.md#recoverable-system-updates).

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
plugins and shared-model selection remain available and survive ordinary restart. Normal personal-provider settings are disabled; terminals and user plugins remain available.
The container isolates the private home/workspace and limits direct host access;
authenticated external proxy access requires the declared public host inventory.


## Management interface

Account management, Model management and System settings have stable addresses at
`/admin/accounts`, `/admin/models` and `/admin/settings`. The old `/admin` entry opens Accounts; model/update anchors open their corresponding
page. On narrow
screens, open the navigation menu. Appearance at the bottom of navigation offers
System, Light and Dark; the same choice applies to login, initialization and
recovery, which remain independent of the management application and DSH.

Create or edit an account in a drawer. Usernames are read-only after creation;
contact email can be changed independently without changing sessions, role,
password or user space. Other account actions remain explicit. A rejected save
keeps the draft and shows the error. Leaving an edited drawer or provider asks
whether to save, discard or continue editing.

Select a provider on the left and edit its connection and model rows on the
right, then save explicitly. A blank stored-key field retains the existing key.
Model rows retain their identifiers when renamed or enabled/disabled. Choose the
platform default separately. A concurrent revision conflict retains your draft
and offers an explicit reload of current settings.

System settings shows installed and verified running versions. Check, download
and confirm application remain separate actions. The current phase, action and
provided elapsed times are visible; a percentage appears only with a known
total. Detailed diagnostics are expandable. Transport failure shows an unknown
result while reconnecting to the same operation; authorization errors are
reported directly. Failure and previous-version restoration have distinct
results. Applying still interrupts tasks immediately after confirmation.

In DSH, the platform avatar and username appear near the bottom of the native
sidebar, above the original Settings entry. The upward menu contains Restart
instance and Log out. Collapsed navigation retains an accessible avatar button.
The platform menu follows DSH's own theme; native Settings remains available.

## Develop and contribute

[Development instructions](CONTRIBUTING.md) include exact pinned Node/pnpm,
an external pinned DSH build, environment setup and public-entry tests. **Process
mode is for local trusted development and provides no filesystem or network
isolation.** Mac development is distinct from Linux container verification and
clean Ubuntu installation.

See the English [architecture](docs/architecture.md), [ADRs](docs/architecture.md#key-decisions)
and [CI/release contract](CONTRIBUTING.md#checks-candidates-and-release-promotion). The platform does not provide
open registration, multiple deployment distributions, automatic upgrades or an
enterprise administration system.

Licensed under [Apache-2.0](LICENSE), with [NOTICE](NOTICE) and a
[trademark statement](TRADEMARKS.md). DSH and other external dependencies retain
their own licenses and notices.
