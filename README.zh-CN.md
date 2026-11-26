# dsh-phalanx

[English](README.md)

## 为团队自托管 DSH，每人一个独立工作空间。

**成员开箱即用，密钥留在平台。** 管理员在一台 Linux 主机上统一配置共享模型、插件、技能与 MCP 服务；成员打开浏览器就能使用原版 DeepSeek Harness，各自拥有独立的容器和持久化工作区。

**[在线体验 →](https://phalanx.htmlgo.to/)** · **[在 Linux 上自部署](#快速安装)** · **[架构说明](docs/architecture.md)**

![管理员按组分发插件、技能和 MCP 服务。每位成员在独立容器中使用原生 DSH，工作文件各自保存。共享模型请求经平台网关转发，供应商密钥由网关注入。](docs/diagrams/team-workspaces.png)

## 为什么选择 dsh-phalanx

- **每人一个独立的 rootless Podman 容器。** 成员在各自容器中运行 DSH 和终端，个人目录与工作区彼此隔离。管理员可为全体或单个成员设置 CPU、内存与进程数额度，并按需配置空闲回收或常驻实例。
- **DSH 源码零改动。** 平台将原版 DSH（当前镜像跟进 [`dsh-v0.2.2-rc.5`](runtime-versions.json)）与运行依赖打包为固定版本镜像，所有集成仅通过官方 CLI、配置与 HTTP/WebSocket 接缝完成。成员看到的和使用的都是原生 DSH 界面与生态。
- **平台代持密钥，不止于模型。**
  - **共享模型网关**：支持 Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses 协议，供应商密钥只在网关注入，不下发到成员容器。
  - **插件、MCP 与技能凭据隔离**：插件上游、远程/共享 MCP 服务以及技能的平台代执行命令均由平台持有上游凭据；成员与 agent 可在授权范围内调用能力，却无法从容器读出真实密钥。
- **签名广场与共享运行依赖。** 插件、技能和 MCP 广场共用 Ed25519 签名目录，管理员可按组管控、一次性预装，或上架到「平台应用中心」供成员自选；CLI、Python 库和文档 SDK 等运行依赖只准备一次、只读共享。
- **为日常运维而设计。** 提供单脚本安装（支持交互式、无人值守及官方/中国大陆下载源）、内置或外置 PostgreSQL、带失败自动回滚的原地系统升级、独立于 DSH 的 `/recovery` 实例恢复页，以及浏览器多账户切换与使用记录审计。

## 工程与安全设计

如果你准备自部署、审阅安全边界或参与代码讨论，这些是本仓库坚持的工程约束：

- **极简运行时依赖**：服务端控制面运行在 Node.js 与 PostgreSQL 之上，仅引入 **6 个生产依赖**（`cookie-es`、`http-proxy-3`、`pg`、`ws`、`yaml`、`yauzl`），无重型框架，无 ORM 黑盒。
- **强制执行边界的分层架构**：`src/` 按 7 层依赖表组织，所有 DSH 协议细节收敛在 `src/dsh/`；自定义 lint 门禁强制检查跨层依赖、单文件行数上限以及双语文档结构对称，详见[架构文档（英文）](docs/architecture.md)。
- **明确的加密与存储隔离**：平台密钥使用 AES-256-GCM 信封加密（绑定记录与字段 AAD），独立主密钥留在宿主本地；持久用户数据、平台数据库与可重建的投影目录严格分离。
- **面向真实环境的验证**：除基于假端口（fake-port）的快速单元测试外，核心隔离、安装与升级路径均在真实 DSH、rootless Linux 容器及跨版本升级环境中持续验收。

## 在线体验

在体验站首页点击「在线体验」，登录后即可拉起一套临时站点。站点预置了带少量体验额度的模型密钥，可直接体验原生 DSH 对话与平台管理能力。

- 每个临时站点限时 **1 小时**，到期后站点与数据一并清理。
- 体验站共享宿主机资源，首次启动 DSH 会偏慢；自部署在独立主机上通常快得多。

**[打开在线体验站 →](https://phalanx.htmlgo.to/)**

## 快速安装

准备一台**具备 sudo 权限的 Debian 系 amd64 主机**（Ubuntu 24.04 与 26.04 已完整验证）。安装器会自动准备宿主依赖、rootless Podman 服务账户、运行环境与配套 DSH 镜像（当前跟进 [`dsh-v0.2.2-rc.5`](runtime-versions.json)），无需提前安装 Node.js 或在本地构建镜像。

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

安装过程支持中文/英文界面以及官方/中国大陆下载源，也支持 `--non-interactive` 无人值守部署。完成后打开终端输出的初始化链接，依次完成：

1. 选择内置 PostgreSQL 或连接外部 PostgreSQL；
2. 创建首个管理员账户；
3. 配置首个共享模型供应商并创建成员账户。

完整的主机要求、HTTPS 反向代理配置与首次登录步骤见[安装说明](docs/install.zh-CN.md)。

## 文档导航

| 你想了解什么 | 文档 |
| --- | --- |
| 从空主机安装、HTTPS 配置到成员首次进入 DSH | [安装说明](docs/install.zh-CN.md) · [English](docs/install.md) |
| 备份、原地升级、数据库切换、迁移与恢复 | [运维指南](docs/operations.zh-CN.md) · [English](docs/operations.md) |
| 管理账户、分组、共享模型、平台功能与广场资源 | [管理员指南](docs/admin-guide.zh-CN.md) · [English](docs/admin-guide.md) |
| 插件上游、原生服务绑定与 MCP 服务接入 | [插件与 MCP 接入](docs/plugin-access.zh-CN.md) · [English](docs/plugin-access.md) |
| 技能平台代执行与共享运行依赖 | [技能代执行](docs/skill-execution.zh-CN.md) · [English](docs/skill-execution.md) |
| 使用 DSH、平台应用中心、产物下载与恢复页 | [成员指南](docs/member-guide.zh-CN.md) · [English](docs/member-guide.md) |
| 分层、接缝归属、运行时保证与设计取舍 | [架构图](docs/diagrams/overview-light.svg) · [架构文档（英文）](docs/architecture.md) |
| 本地开发、镜像构建、真实 DSH 测试与发布流程 | [贡献指南（英文）](CONTRIBUTING.md) |
| 每次发布的变化与验收记录 | [Releases](https://github.com/dake6767/dsh-phalanx/releases) |

## 社区、许可与商标

这是社区项目，与 DeepSeek 无隶属关系，也未获其背书。项目欢迎架构讨论和可复现的问题报告，采用 low-touch 维护，不承诺支持 SLA 或响应时间。

代码采用 [Apache-2.0](LICENSE)，另见 [NOTICE](NOTICE) 与[商标声明](TRADEMARKS.md)。DSH 及其他外部依赖保留各自的许可和声明。
