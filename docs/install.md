# Ubuntu installation

The supported host is Ubuntu 24.04 LTS amd64 with sudo access. The installer
supplies host packages, a dedicated rootless Podman identity, the bundled
runtime, the verified platform package and its matching DSH image. Deployers do
not need development Node.js, pnpm, GitHub CLI or a local image build.

## Public release path

Version 0.1.0 is still under development. This command becomes usable after
the repository, stable Release and container package are published:

```sh
curl -fsSL https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh | sudo bash
```

The default selects the completed stable `v0.1.0` Release and excludes previews.
To select it explicitly, append `-s -- --version v0.1.0` to `sudo bash`.
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
`http://127.0.0.1:18080/bootstrap`. A public HTTPS proxy is configured separately.
`--listen-address` (an IPv4/IPv6 literal), `--port` and `--public-origin` select explicit deployment facts
at the first installation.

Read `/var/lib/dsh-phalanx/data/bootstrap-credential` with sudo. Its `credential`
value creates the first administrator at `/bootstrap`; the service removes the
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
