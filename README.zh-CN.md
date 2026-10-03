# dsh-phalanx

[English](README.md) · [安装说明](docs/install.zh-CN.md) · [开发指南（英文）](docs/development.md)

dsh-phalanx 为小团队自托管 DeepSeek Harness（DSH）。每位成员有私有 home 与
workspace，可使用原生设置、插件和自有模型。部署者配置一次默认模型，成员可自行
覆盖；管理员从一个页面管理账户。首版不提供公开注册。

这是 **community project, not affiliated with DeepSeek（非 DeepSeek 官方项目）**，
未获 DeepSeek 背书。项目以架构反馈和可复现问题为导向，采用 low-touch 维护，
不承诺支持 SLA 或响应时间。已完成的稳定版本见
[Releases](https://github.com/dake6767/dsh-phalanx/releases)；候选预览须显式指定。

## 安装到 Ubuntu

支持 **Ubuntu 24.04 LTS、amd64、sudo**，默认以 rootless Podman 运行用户实例；
平台作为宿主 systemd 服务运行。安装器供给主机依赖、随包 Node 运行时及经过校验的
配套 DSH 镜像。已完成的公共稳定版本无需开发用 Node/pnpm、GitHub 账号、
registry 登录或本地构建镜像。

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

默认选择最新的**已完成稳定版**，排除预发布。如果还没有稳定 Release，使用
[私有候选交付方式](docs/install.zh-CN.md#私有候选验收)。首次执行会询问默认模型密钥
和服务器全部公网 IPv4（包括 NAT 别名）；重复执行保留受保护配置及用户数据。
[安装说明](docs/install.zh-CN.md)包含指定版本、首次管理员、服务操作、配置、重试、
备份和当前支持限制。

默认后台是**服务器本机**的 `http://127.0.0.1:18080`。从自己的电脑访问时使用 SSH
转发，或配置[可信 HTTPS 代理（英文）](docs/https-preview.md)。默认不会把服务器 IP
的 HTTP18080 作为公网入口。

## 账户与用户空间

在 `/bootstrap` 使用受保护的首次凭据创建管理员，再到 `/login` 登录、`/admin`
创建成员。成员从 `/` 进入原生 DSH；每账户最多关联一个实例。管理员可创建账户、
重置密码、禁用/启用、删除以及任命管理员。重置密码使旧会话失效但保留实例；
禁用/删除撤销访问并停止实例。删除保留文件并永久保留用户名。最后一位启用中的
管理员不能被禁用、删除或降权。

共享上游密钥留在平台，不进入成员空间。原生设置、插件与自有模型选择由用户管理，
普通重启后保留。容器隔离私有 home/workspace 并限制直接访问宿主；经认证的外部
代理访问需要完整的公网宿主地址清单。

## 开发与贡献

[英文开发指南](docs/development.md)给出固定 Node/pnpm、外部固定 DSH 构建、环境
配置及公开入口测试。**进程开发模式只适合本机可信用户，不提供文件系统或网络隔离。**
Mac 源码开发、Linux 容器验收和干净 Ubuntu 安装是不同的验证环境。

设计见英文[架构](docs/architecture.md)、[ADR](docs/adr/README.md)和
[CI/发布契约](docs/ci-release.md)。0.1.0 不承诺开放注册、多发行版安装、自动升级
或企业管理系统。

代码采用 [Apache-2.0](LICENSE)，另见 [NOTICE](NOTICE) 与[商标声明](TRADEMARKS.md)。
DSH 及其他外部依赖保留各自许可和声明。
