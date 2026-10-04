# dsh-phalanx

[English](README.md) · [安装说明](docs/install.zh-CN.md) · [开发指南（英文）](docs/development.md)

dsh-phalanx 为小团队自托管 DeepSeek Harness（DSH）。每位成员有私有 home 与
workspace，可使用原生设置、插件和共享模型。管理员配置共享供应商和默认模型，成员可选择
全部启用的共享模型；管理员从一个页面管理账户。首版不提供公开注册。

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
[私有候选交付方式](docs/install.zh-CN.md#私有候选验收)。0.1.1 首次执行确认浏览器
访问地址与全部公网 IPv4；无需模型密钥即可安装。打开终端输出的初始化链接，
填写管理员用户名和密码后直接进入管理页，页面显示模型尚未配置。
重复安装保留受保护配置及用户数据。

全新 0.1.1 默认监听 `0.0.0.0:18080`，须确认可达的局域网或公网 URL。
HTTPS、域名和云安全组由部署者配置。[安装说明](docs/install.zh-CN.md)包含独立
数据盘、链接重新生成、服务操作和保留的 0.1.0 安装行为。

## 账户与用户空间

首次开户后在 `/admin` 创建成员，后续从 `/login` 登录。成员进入稳定的 `/app/<spaceId>/`，
普通重启后书签不变；旧 `/` 自动跳到自己的空间。管理员仍使用 `/admin`，通过 Open DSH
进入自己的空间。空间标识不是凭据，HTTP 与 WebSocket 都要求当前登录及归属验证。
每账户最多关联一个实例。管理员可创建账户、
重置密码、禁用/启用、删除以及任命管理员。重置密码使旧会话失效但保留实例；
禁用/删除撤销访问并停止实例。删除保留旧空间文件，同名新账户获得新空间。最后一位启用中的
管理员不能被禁用、删除或降权。

共享上游密钥留在平台，不进入成员空间。成员保留原生非模型设置、终端、插件与共享模型选择，普通个人供应商配置操作在 0.1.1 中关闭，
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

### 成员登出与恢复

DSH 内的受保护平台插件提供独立的「Log out」和「Restart instance」入口。登出只清除当前浏览器平台登录，已接受的任务继续执行。重启前须确认中断任务；成功后通过「Return to DSH」回到同一空间，配置、用户插件、聊天和文件保留。

即使 DSH 启动失败，有效成员凭据仍可登录平台并直接进入恢复页。DSH 无法加载时直接访问部署地址的 `/recovery`，仍可登出、重启并查看失败或成功反馈。配置损坏导致重启失败时，请管理员重置 DSH 环境。平台始终使用当前登录身份决定目标。平台插件文件在容器中只读，原生插件管理操作不能停用或卸载；成员仍能使用终端和安装自己的插件。此保护不承诺任意用户代码无法干扰本人 DSH。

### 管理员重置 DSH 环境

在成员管理页为已启用成员选择「Reset DSH environment」，确认中断运行任务后执行。即使成员无法打开 DSH，管理员仍可操作。平台先停止该成员实例，完成私有备份，再重置 web profile（含自装插件）、home patch/环境变量及尚未导入的旧 Settings，最后启动替代实例。空间 URL、项目、聊天和其他个人文件保留；尚无实例的成员也可通过该操作启动。

备份失败保留原配置；重置或启动失败会报告已完成备份及恢复信息，不伪报成功。备份位于平台数据根 `environment-backups/<spaceId>/<backupId>`，成员容器不挂载，可能包含私有配置和凭据。结果指向给部署者的 `README.txt` 及记录原有/原先不存在载体的 manifest。人工恢复须先停平台服务并核实目标容器已移除，将当前载体另存，再只恢复清单所列原配置，不能跟随符号链接。只停平台服务可能留下容器；恢复旧备份也会恢复原故障。旧备份不自动清理。
