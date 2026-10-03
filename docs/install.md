# Ubuntu installation

[简体中文](install.zh-CN.md)

The supported host is Ubuntu 24.04 LTS amd64 with sudo access. The installer
supplies host packages, a dedicated rootless Podman identity, the bundled
runtime, the verified platform package and its matching DSH image. Deployers do
not need development Node.js, pnpm, GitHub CLI or a local image build.

## Public release path

Use this path after the repository, stable Release and container package are
publicly available. See [Releases](https://github.com/dake6767/dsh-phalanx/releases)
for completed versions; before a stable release exists, use explicit candidate supply:

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

The default resolves GitHub’s latest completed stable Release and excludes previews.
To select a version explicitly, run `sudo bash install.sh --version v0.1.0`.
If `curl` is absent, install it with `sudo apt-get update && sudo apt-get install -y curl`,
or download the standalone script through a browser and transfer it to the host.
The platform package and image digest come from the same Release manifest;
checksums, tag commit and image identity must agree. The image is pulled from
`ghcr.io/dake6767/dsh-phalanx` by digest. Installation does not register an
automatic updater. Anonymous public download and pull are verified at release.

The first installation prompts through the terminal for a default provider API
key and the complete public IPv4 inventory, including NAT aliases. Submit an
empty inventory only on a host with no public IPv4 addresses. The credential is
hidden during input. The default model is `deepseek-chat` through DeepSeek's
official endpoint. A protected regular file can supply the key with
`--model-key-file /path/to/key` for noninteractive installation; restrict its
permissions to `0600` and remove the input file afterwards.

## Entry and durable state

The initial entry listens on `127.0.0.1:18080` on the Ubuntu host. From another
machine, forward that port through SSH, then open
`http://127.0.0.1:18080/bootstrap`. For example, run
`ssh -N -L 18080:127.0.0.1:18080 your-server` on your computer, replacing
`your-server` with your SSH host. That computer must have its local18080 free.
A [public HTTPS proxy](https-preview.md) is configured separately.
`--listen-address` (an IPv4/IPv6 literal), `--port` and `--public-origin` select explicit deployment facts
at the first installation.

Read `/var/lib/dsh-phalanx/data/bootstrap-credential` with sudo. Its first whitespace-separated field
is the credential; the second is an expiry timestamp. Only the first field creates the first administrator at `/bootstrap`; the service removes the
file after bootstrap. Sign in at `/login`, then create members at `/admin`.

The installer owns `/opt/dsh-phalanx/releases` and its `current` link. Protected
deployment configuration lives in `/etc/dsh-phalanx/environment`. Accounts and
private user files live under `/var/lib/dsh-phalanx/data`. The `dsh-phalanx`
service account runs the platform and rootless containers, with a user systemd
unit and linger enabled so it starts after reboot without an interactive login.
AppArmor remains enabled; compatibility profiles are limited to Podman and pasta.

Repeating the command retains deployment secrets, accounts and files. Conflicting
configuration flags fail explicitly; edit the protected file deliberately to
change an existing deployment. A checksum or dependency failure exits nonzero.
Failed release activation restores the previous release when one exists. Do not
delete the data root to retry installation.

For a service failure, inspect the installer error and the service journal:

```sh
sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 100
```

## Private candidate validation

While the repository and registry are private, a release owner supplies the
standalone installer plus the original `manifest.json`, `SHA256SUMS`, platform
archive and OCI archive from one candidate Release. Transfer them through the
authorized private channel. No deployer GitHub token is embedded in the script.

```sh
sudo bash install.sh --version v0.1.0-rc.N --bundle-dir /path/to/candidate
```

Replace `N` with the exact candidate number. The installer verifies both complete
archives and imports the OCI image into its own rootless storage. An unrelated
preloaded image cannot stand in for this supply step. This explicit archive
handoff is for private validation; the public release path downloads the package
and pulls the matching digest anonymously.

Use `--gateway-port PORT` to choose an unused private model/network gateway port
on an existing host. The default is3081; the listener always remains loopback.
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
correct network/dependency/port/key problems and rerun the same verified version.
An archive hash mismatch must be repaired by obtaining the original matching
assets; never edit the checksum inventory. Automatic rollback applies to failed
activation. An intentional rollback requires the previous completed release and
matching image/configuration; no cross-version data migration is promised.

## Configuration and supported scope

The first-run flags are shown by `bash install.sh --help`: upstream URL/provider/model,
protected key file, public IPv4 inventory, listener/port, exact public origin and
private gateway port. Defaults are DeepSeek official `deepseek-chat`, backend
loopback18080, gateway loopback3081 and container mode. `--gateway-port` changes
the private port, not its bind address. Behind HTTPS set the exact public origin
including its external port. A complete public IPv4 inventory prevents user
proxies from reaching declared host aliases; missing facts close external proxy access.

Only Ubuntu 24.04 LTS amd64 is supported by this installer. Mac process development
is documented [separately](development.md) and has no container isolation guarantee.
Linux tests prove container behavior; existing Linux servers do not establish a
clean-install result. This project has no public registration, automatic updater,
multiple host distributions or support SLA. Candidate validation and ordinary CI
are separate from completed public release acceptance.
