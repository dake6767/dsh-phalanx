# dsh-phalanx

[简体中文](README.zh-CN.md)

dsh-phalanx is a self-hosted, multi-user DSH platform for small teams: run DeepSeek Harness (DSH) on one server and give every member an independent user space.

Teams do not need to deploy DSH for each person or distribute shared model keys. The deployer installs the platform, administrators create accounts and configure shared model providers, and members sign in to work in their own spaces.

## Four highlights

- **One rootless container per member.** Each member's DSH instance runs in its own container, with persistent home and workspace directories kept separate from other members' files.
- **Integration through official DSH seams.** The platform uses DSH's official CLI, configuration, plugins and HTTP/WebSocket interfaces, without forking or modifying DSH source.
- **A shared model gateway.** Administrators configure shared model providers once; members select enabled models. Provider keys stay in the platform and never enter member spaces. Members can still access external models through their terminals and their own plugins.
- **Plugin freedom.** Members can install native DSH plugins and use the terminal and non-model settings. The platform's account-menu plugin is protected and cannot be disabled or uninstalled through ordinary plugin management.

## How multi-user DSH works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/overview-dark.svg">
  <img alt="Architecture overview of the browser, platform service, member containers, shared model gateway and persistent storage" src="docs/diagrams/overview-light.svg">
</picture>

The browser connects to the platform service, which handles sign-in, sessions and the admin UI. When a member visits `/app/<spaceId>/`, the platform verifies that the current account owns that user space, then forwards HTTP and WebSocket requests to the member's DSH instance.

Each instance mounts its own home and workspace, along with the read-only platform plugin and shared model configuration. Shared model requests pass through the model gateway, which selects the provider and injects its key when forwarding upstream. Account state and provider keys live in the platform data root; members' persistent files live in the user data root.

## Quick installation

On an **Ubuntu 24.04 LTS, amd64 host with sudo access**, run:

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

The installer selects the latest completed stable release and prepares host dependencies, the platform service and its matching DSH image. No developer Node.js/pnpm installation or model key is needed to install. Confirm the access address and public IPv4 inventory when prompted, open the initialization link to create the first administrator, then configure shared model providers.

The deployer configures HTTPS, DNS and cloud security groups. See the installation guide for detailed steps.

## Documentation

| What you need | Guide |
| --- | --- |
| Installation, storage, HTTPS, service management and recovery | [Installation guide](docs/install.md) · [简体中文](docs/install.zh-CN.md) |
| Layers, seam ownership, runtime guarantees and design tradeoffs | [Architecture](docs/architecture.md) |
| Local development, real DSH tests and the release process | [Contributing](CONTRIBUTING.md) |
| Changes and acceptance records for each release | [Releases](https://github.com/dake6767/dsh-phalanx/releases) |

## Community, license and trademarks

This is a community project, neither affiliated with nor endorsed by DeepSeek. Architecture discussions and reproducible issue reports are welcome. Maintenance is low-touch, with no support SLA or promised response time.

The code is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and the [trademark statement](TRADEMARKS.md). DSH and other external dependencies retain their own licenses and notices.
