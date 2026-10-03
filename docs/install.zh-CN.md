# Ubuntu 安装

[English](install.md)

支持 Ubuntu 24.04 LTS amd64，须有 sudo 权限。安装器供给主机依赖、独立 rootless
Podman 身份、随包运行时、已校验平台包及配套 DSH 镜像，无需开发用 Node/pnpm、
GitHub CLI 或本地构建镜像。

## 公共稳定版本

仓库、稳定 Release 和 GHCR 包公开后使用：

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

若没有 curl，可运行 `sudo apt-get update && sudo apt-get install -y curl`，也可用浏览器
下载独立脚本后传到服务器。默认选择 GitHub 最新的已完成稳定 Release，排除预发布。
指定版本使用 `sudo bash install.sh --version v0.1.0`。如果还没有稳定 Release，使用下文
私有候选流程；已完成版本见 [Releases](https://github.com/dake6767/dsh-phalanx/releases)。

平台归档和镜像 digest 来自同一 manifest，校验值、tag 提交、镜像身份必须匹配。
镜像从 `ghcr.io/dake6767/dsh-phalanx` 按 digest 拉取；不启用自动更新。
完成公共发布的版本无需 GitHub 账号或 registry 登录。

首次执行从终端询问默认模型密钥与全部公网 IPv4，包括 NAT 别名；仅在确实没有
公网 IPv4 时提交空清单。密钥输入不回显；默认使用官方 DeepSeek 的 deepseek-chat。
非交互安装可用 `--model-key-file /path/to/key`，文件须为受保护的普通文件，权限0600，
成功后删除输入副本。上游 URL/provider/model 可通过对应选项配置。

## 入口与账户

默认监听**服务器本机**的 `127.0.0.1:18080`。从电脑执行
`ssh -N -L 18080:127.0.0.1:18080 your-server`（替换 SSH 主机，电脑本地18080须空闲），
再打开 `http://127.0.0.1:18080/bootstrap`。公网入口另配
[可信 HTTPS 代理](https-preview.md)。首次安装用 `--listen-address`、`--port`、
`--public-origin` 设置明确的监听地址、端口和完整公开 origin。

用 sudo 读取 `/var/lib/dsh-phalanx/data/bootstrap-credential`。
第一段空白分隔字段是首次凭据，第二段是过期时间戳；只填第一段。在 `/bootstrap`
创建管理员后该文件删除。到 `/login` 登录，再在 `/admin` 创建成员。成员从 `/`
进入原生 DSH。没有开放注册；最后一位启用的管理员受到保护。

管理员可创建、重置密码、禁用/启用、删除及任命管理员。重置密码使旧会话失效但
保留实例；禁用/删除撤销访问并停止实例。删除保留文件且用户名不能重用。
启用后须重新登录。原生设置、插件、自有模型选择在普通重启后保持，默认模型可覆盖。

## 服务、配置与重试

平台版本在 `/opt/dsh-phalanx/releases`，`current` 指向活跃版本；受保护配置在
`/etc/dsh-phalanx/environment`，账户及用户文件在 `/var/lib/dsh-phalanx/data`。
独立 `dsh-phalanx` 用户服务通过 linger 开机启动。AppArmor 保持启用，兼容 profile
仅作用于 Podman/pasta。

在 Ubuntu 主机运行以下命令，仅操作本次平台用户服务：

```sh
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user status dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user restart dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user stop dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user start dsh-phalanx.service
sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 100
```

stop 不取消开机启动。同样前缀下 `systemctl --user disable --now` 可暂停开机启动，
`enable --now` 恢复。可选 HTTPS edge 服务单独管理，不重启共享 nginx。

重复安装保留配置、账户与文件，冲突配置选项明确失败。既有配置须用 sudo 编辑受保护
文件，再重启平台；保留所有权及0640权限，勿把含密钥配置粘贴到问题报告。
一致性备份须先停服务，保留配置和完整 data 目录及权限。普通重启重建本次拥有的
容器，保留文件与原生配置。首版不提供自动灾难恢复或数据擦除工具。

校验/依赖失败非零退出。查看具体失败，修复网络、依赖、端口或密钥后，用同一已校验
版本重试，不删除用户数据。归档不匹配须重新获取匹配资产，不能改校验清单。
激活失败会恢复原版本（如存在）；主动回退须使用此前已完成版本及配套镜像/配置，
不承诺跨版本数据迁移。

## 私有候选验收

仓库和 registry 私有时，由发布者提供独立安装器及同一候选的四个原始资产：
`manifest.json`、`SHA256SUMS`、平台归档、OCI归档，经授权的私有通道传递。
Mac 账号的 GitHub token 不写入脚本、不复制给验证机。

```sh
sudo bash install.sh --version v0.1.0-rc.N --bundle-dir /path/to/candidate
```

N 替换为精确候选编号。安装器完整校验两份归档并导入自己的 rootless 镜像存储，
不能用无关预加载镜像替代供给。公共版本使用匿名下载与配套 digest 拉取。

`--gateway-port PORT` 可选已有主机上空闲的私有网关端口，默认3081，始终 loopback；
重复安装保留此配置，拒绝冲突选项。HTTPS 后须设置含外部端口的完整公开 origin。
公网 IPv4 清单须完整，缺少部署事实时外部代理关闭。

Mac 仅用于源码及无隔离承诺的进程开发；Linux 用于真实容器验收；干净 Ubuntu 主机
用于安装/依赖/重试/重启验证。已有云主机不能替代干净安装证据。首版不支持多发行版、
开放注册或自动升级；维护为 feedback-oriented/low-touch，不承诺 SLA。
