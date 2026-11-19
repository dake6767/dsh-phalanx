# dsh-phalanx

[简体中文](README.zh-CN.md)

## Self-host DSH for your team. Give every member their own workspace.

**Ready from the first sign-in.** An administrator sets up shared models and plugins for the team. Members open their browser and start using native DeepSeek Harness.

[Self-host on Linux](#quick-installation)

![An administrator assigns plugins, skills and MCP services by group. Each member has a separate DSH container and persistent files. The shared gateway adds the provider key when forwarding model requests.](docs/diagrams/team-workspaces.png)

## Highlights

- **One dedicated rootless Podman container per member.** Each member runs DSH and a terminal in their own container. Home and workspace directories are separate for each member.
- **Unmodified upstream DSH.** Phalanx packages DSH and its runtime dependencies in a container image and connects through the official CLI, configuration and HTTP/WebSocket interfaces. Members use the native DSH interface in their browser.
- **The DSH plugin ecosystem.** By default, members can install native plugins themselves. They can also choose plugins, skills and MCP services from the Platform App Center. Administrators can pick plugins from the catalog and preinstall them for a group.
- **Shared models with centrally held keys.** Members select an enabled model in DSH. The platform holds the provider key, and the gateway adds it when forwarding the request to the provider.
- **Group access and usage records.** Administrators grant access to plugins, skills and MCP services by group. In Usage records, they can check shared model usage and trace tool calls routed through the platform gateway by member or group.

## Quick installation

Use a **Debian-family amd64 host with sudo access**. Ubuntu 24.04 and 26.04 have been verified. The installer provides the runtime and matching DSH image.

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

You can also choose **在线体验** (online demo) on the demo homepage and sign in to create a temporary site. We include a model API key with a small usage allowance so you can try chatting in native DSH.

**Each demo site lasts one hour.** When the hour is up, the site and its data are deleted. The demo has limited resources, so DSH can take a little longer to start the first time. It typically starts much faster on a self-hosted deployment.

**[Try it online →](https://phalanx.htmlgo.to/)**

Open the initialization link printed by the installer, create the first administrator, then configure a shared model and a member account. For host requirements, HTTPS and first sign-in, see the [installation guide](docs/install.md).

## Documentation

| What you need | Guide |
| --- | --- |
| Install on a new host and open DSH as the first member | [Installation guide](docs/install.md) · [简体中文](docs/install.zh-CN.md) |
| Back up, upgrade, move or recover a deployment | [Operations](docs/operations.md) · [简体中文](docs/operations.zh-CN.md) |
| Manage accounts, models, platform features and resource distribution | [Administrator guide](docs/admin-guide.md) · [简体中文](docs/admin-guide.zh-CN.md) |
| Use DSH, Platform App Center, files and instance recovery | [Member guide](docs/member-guide.md) · [简体中文](docs/member-guide.zh-CN.md) |
| Layers, seam ownership, runtime guarantees and design tradeoffs | [Architecture diagram](docs/diagrams/overview-light.svg) · [Architecture guide](docs/architecture.md) |
| Local development, image builds, real DSH tests and the release process | [Contributing](CONTRIBUTING.md) |
| Changes and acceptance records for each release | [Releases](https://github.com/dake6767/dsh-phalanx/releases) |

## Community, license and trademarks

This is a community project, neither affiliated with nor endorsed by DeepSeek. Architecture discussions and reproducible issue reports are welcome. Maintenance is low-touch, with no support SLA or promised response time.

The code is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and the [trademark statement](TRADEMARKS.md). DSH and other external dependencies retain their own licenses and notices.
