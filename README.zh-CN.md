# dsh-phalanx

[English](README.md)

dsh-phalanx 是面向小团队的多用户 DSH 自托管平台：在一台服务器上运行 DeepSeek Harness（DSH），让每位成员都有独立的用户空间。

团队不必为每个人重复部署 DSH、分发共享模型密钥。部署者安装平台，管理员创建账户、配置共享模型供应商，成员登录后就能在自己的空间里工作。

## 四项亮点

- **每人一个 rootless 容器。** 每位成员的 DSH 用户实例运行在独立容器中，home 和 workspace 分开持久保存，彼此不共享文件目录。
- **通过官方接缝集成 DSH。** 平台使用 DSH 官方 CLI、配置、插件及 HTTP/WebSocket 接口，不 fork、不修改 DSH 源码。
- **统一模型网关。** 管理员配置一次共享模型供应商，成员直接选择启用的模型。供应商密钥留在平台，不进入成员空间；成员仍可通过终端和自己的插件访问外部模型。
- **保留插件自由。** 成员可以安装原生 DSH 插件、使用终端及非模型设置。平台提供的账户菜单插件受保护，不能通过普通插件管理停用或卸载。

## 多用户 DSH 如何运行

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/overview-dark.svg">
  <img alt="浏览器、平台服务、成员容器、共享模型网关及持久存储架构总览" src="docs/diagrams/overview-light.svg">
</picture>

浏览器先连接平台服务，由平台处理登录、会话和管理界面。成员访问 `/app/<spaceId>/` 时，平台核对当前账户与用户空间归属，再把 HTTP 和 WebSocket 请求转发给该成员的 DSH 用户实例。

每个用户实例挂载自己的 home 和 workspace，以及只读的平台插件与共享模型配置。共享模型请求经过模型网关，网关选择对应供应商，并在发往上游时注入密钥。账户、供应商密钥等状态保存在平台数据根；成员的持久文件保存在用户数据根。

## 快速安装

准备一台 **Ubuntu 24.04 LTS、amd64 架构且有 sudo 权限**的主机，运行：

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

安装器选择最新的已完成稳定版，准备主机依赖、平台服务及配套 DSH 镜像。无需预装开发用 Node.js/pnpm，也无需模型密钥即可安装。按提示确认访问地址和公网 IPv4 清单，打开输出的初始化链接创建首个管理员，再配置共享模型供应商。

HTTPS、域名和云安全组由部署者配置，详细步骤见安装说明。

## 文档导航

| 你想了解什么 | 文档 |
| --- | --- |
| 安装、存储、HTTPS、服务管理与恢复 | [中文安装说明](docs/install.zh-CN.md) · [English](docs/install.md) |
| 分层、接缝归属、运行时保证与设计取舍 | [架构文档（英文）](docs/architecture.md) |
| 本地开发、真实 DSH 测试与发布流程 | [贡献指南（英文）](CONTRIBUTING.md) |
| 每次发布的变化与验收记录 | [Releases](https://github.com/dake6767/dsh-phalanx/releases) |

## 社区、许可与商标

这是社区项目，与 DeepSeek 无隶属关系，也未获其背书。项目欢迎架构讨论和可复现的问题报告，采用 low-touch 维护，不承诺支持 SLA 或响应时间。

代码采用 [Apache-2.0](LICENSE)，另见 [NOTICE](NOTICE) 与[商标声明](TRADEMARKS.md)。DSH 及其他外部依赖保留各自的许可和声明。
