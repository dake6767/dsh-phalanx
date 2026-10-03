# dsh-phalanx

[简体中文](README.zh-CN.md) · [Installation](docs/install.md) · [Development](docs/development.md)

dsh-phalanx hosts DeepSeek Harness (DSH) for small self-hosted teams. Each member
has a private home and workspace, native settings, plugins and model choices.
The deployer configures one default model; members can override it. An
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
The first run asks for a default provider key and the host's complete public IPv4
inventory. It retains protected configuration and user data on repetition.
Read [installation](docs/install.md) for exact-version flags, bootstrap, service
commands, configuration, retry, backups and the current target limitations.

The default backend is `http://127.0.0.1:18080` **on the server**. From your
computer use SSH forwarding, or configure a [trusted HTTPS proxy](docs/https-preview.md).
The server's IP is not a public HTTP18080 entry by default.

## Accounts and user spaces

Use the protected bootstrap credential to create the first administrator at
`/bootstrap`, then sign in at `/login` and create members at `/admin`. Members
enter native DSH at `/`; each account has at most one associated instance.
Administrators create accounts, reset passwords, disable/enable accounts, delete
accounts and appoint administrators. Reset revokes existing sessions while
retaining the instance. Disable/delete revoke access and stop the instance;
delete preserves files and reserves the username. The last enabled administrator
cannot be disabled, deleted or demoted.

Default credentials stay in the platform, outside user spaces. Native settings,
plugins and personal models remain user choices and survive ordinary restart.
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
