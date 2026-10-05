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
指定版本使用 `sudo bash install.sh --version v0.1.1`。如果还没有稳定 Release，使用下文
私有候选流程；已完成版本见 [Releases](https://github.com/dake6767/dsh-phalanx/releases)。

平台归档和镜像 digest 来自同一 manifest，校验值、tag 提交、镜像身份必须匹配。
镜像从 `ghcr.io/dake6767/dsh-phalanx` 按 digest 拉取；不启用自动更新。
完成公共发布的版本无需 GitHub 账号或 registry 登录。

0.1.1 安装不要求模型密钥。首次执行确认或覆盖候选访问地址，并填写全部公网 IPv4
（包括 NAT 别名）；仅在确实没有公网 IPv4 时提交空清单。非交互安装通过
`--public-origin` 和 `--host-public-addresses` 明确提供这些信息。
旧的静态模型配置仍可用 `--model-key-file /path/to/key`，须为权限 0600 的普通文件。
显式安装 0.1.0 包时保留原有密钥必填、loopback 监听与手工凭据开户流程。

## 入口与账户

全新 0.1.1 默认监听 `0.0.0.0:18080`。安装器输出完整 `initializationUrl`，管理员
在浏览器打开，填写用户名和密码后直接进入 `/admin`，无需邮箱或二次登录。
管理页会显示模型尚未配置；终端和工作区可用。管理员随后在 **Model settings**
中添加共享供应商、启用模型并指定默认模型。

支持局域网或公网 HTTP，不强制 HTTPS；域名、证书、云安全组由部署者配置。
可另配[可信 HTTPS 代理](https-preview.md)。安装器不能可靠地自动发现云主机的 NAT
公网地址，须确认最终 URL。首次安装可用 `--listen-address`、`--port`、
`--public-origin` 设置监听及浏览器地址。loopback 部署须自行转发端口并指定访问地址。

初始化链接有效期为 24 小时，普通服务重启保留，成功开户后失效。链接片段包含
首次开户凭据，只交给首管理员；安装器只在终端输出，不保存到安装状态文件。
在服务器取回现有链接或重新生成（使旧链接失效）：

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080 --renew
```

将示例地址替换为实际访问 origin。初始化完成后两条命令只返回管理页，不能重开
开户入口。0.1.0 包仍需读取 `data/bootstrap-credential` 第一段字段开户，再登录。
没有开放注册；最后一位启用的管理员受到保护。

管理员可创建、重置密码、禁用/启用、删除及任命管理员。重置密码使旧会话失效但
保留实例；禁用/删除撤销访问并停止实例。删除保留原空间文件；同名新账户获得新空间标识，不继承旧文件、登录或模型访问凭据。
启用后须重新登录。原生设置、插件及仍启用的共享模型选择在普通重启后保持；
新会话采用管理员设置的默认模型。普通成员的个人供应商设置入口在 0.1.1 中关闭。

## 独立用户数据盘（0.1.1）

系统服务的默认平台数据根仍为 `/var/lib/dsh-phalanx/data`，默认用户根为其下的
`users`。新部署先挂载数据盘并配置开机挂载，再运行：

```sh
sudo bash install.sh --version v0.1.1 --user-data-root /mnt/data/dsh-phalanx-users --user-data-mount /mnt/data
```

安装器为新建或空目录设置服务账户归属和 0700 权限，不自动接管非空目录。
两个选项须同时提供，保存为受保护配置中的 `DSH_PHALANX_USER_DATA_ROOT` 与
`DSH_PHALANX_USER_DATA_MOUNT`。容器模式要求独立盘实际挂载于指定挂载点，
不能用系统盘普通目录或父目录挂载代替。开发模式允许宿主目录，但不提供容器隔离。
外部用户根
不能与平台数据根重叠。平台不会格式化磁盘、代管挂载或递归修改已有数据权限。

平台侧 `user-storage-identity` 保存持久随机平台标识，`user-storage.json` 与卷上的
`.dsh-phalanx-storage.json` 将卷绑定到该平台。恢复时须与账户库一起恢复；即使在
原路径重建平台，也不能自动认领旧用户卷。
不要手工编辑或删除它们。缺盘、错误卷、目录不可写或归属异常时拒绝访问，不创建
替代空间。挂载必须先于平台服务恢复。成员 home 和 workspace 一起跟随用户根，
容器内路径保持原样；账户库、模型网关凭据及部署密钥不作为成员数据挂载。

已有用户目录与其持久映射保持原位。切换已有部署的数据盘需要明确的迁移流程；
直接修改或移除上述环境变量不会自动移动数据。备份须同时保存平台数据根、用户
数据根、部署配置和权限。空间标识在登录、普通重启后保持稳定，并可从成员管理
API 的 `spaceId` 字段读取；它不是访问凭据。

成员登录后进入 `/app/<spaceId>/`，旧根入口自动跳转；管理员仍使用 `/admin` 和
Open DSH 链接。每个 HTTP 与 WebSocket 请求都验证当前账户及空间归属。DSH Cookie、
插件资源、RPC 和 manifest 使用相同前缀。HTTPS 由外部代理终止时，将
`--public-origin` 设为完整浏览器访问地址，并向平台转发完整路径和 WebSocket 升级。

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

安装向导确认访问地址和入口端口，展示目录，并提供高级网关/存储配置。无终端须明确
提供 `--public-origin URL --host-public-addresses 完整清单`，无公网别名时才传空字符串。
必要参数或配置无效时，在大型下载前失败。

首次失败后直接重跑向导或传修正参数（如 `--gateway-port 41081`），无需手工编辑配置。
安装器显示变更字段，保留秘密和用户文件，复用校验通过的下载。已成功安装同版同配置
且健康时直接给原入口，不重复部署或重启。成功安装后的冲突参数明确失败，配置和存储
变更仍需显式停服维护；保留所有权及0640权限，勿把含密钥配置粘贴到问题报告。
一致性备份须先停服务，保留配置和完整 data 目录及权限。普通重启重建本次拥有的
容器，保留文件与原生配置。首版不提供自动灾难恢复或数据擦除工具。

校验/依赖失败非零退出。查看具体失败，修复网络、依赖、端口或密钥后，用同一已校验
版本重试，不删除用户数据。归档不匹配须重新获取匹配资产，不能改校验清单。
激活失败会恢复原版本（如存在）；主动回退须使用此前已完成版本、配套镜像/配置
及升级前的一致备份，不提供新版 DSH 已写入数据的自动反向迁移。

## 私有候选验收

仓库和 registry 私有时，由发布者提供独立安装器及同一候选的四个原始资产：
`manifest.json`、`SHA256SUMS`、平台归档、OCI归档，经授权的私有通道传递。
Mac 账号的 GitHub token 不写入脚本、不复制给验证机。

```sh
sudo bash install.sh --version v0.1.1-rc.N --bundle-dir /path/to/candidate
```

N 替换为精确候选编号。安装器完整校验两份归档并导入自己的 rootless 镜像存储，
不能用无关预加载镜像替代供给。公共版本使用匿名下载与配套 digest 拉取。

`--gateway-port PORT` 可选已有主机上空闲的私有网关端口，默认3081；首次安装默认端口占用时可自动选择空闲值并告知、保存。明确指定或已保存
的端口不会静默改变，始终 loopback；
重复安装保留此配置，拒绝冲突选项。HTTPS 后须设置含外部端口的完整公开 origin。
公网 IPv4 清单须完整，缺少部署事实时外部代理关闭。

Mac 仅用于源码及无隔离承诺的进程开发；Linux 用于真实容器验收；干净 Ubuntu 主机
用于安装/依赖/重试/重启验证。已有云主机不能替代干净安装证据。首版不支持多发行版、
开放注册或自动升级；维护为 feedback-oriented/low-touch，不承诺 SLA。

## 0.1.1 共享模型

在管理页的 Model settings 添加供应商名称、Messages Base URL、密钥和逐行模型标识。DeepSeek 填 `https://api.deepseek.com/anthropic`，火山 Coding Plan 填 `https://ark.cn-beijing.volces.com/api/coding`；网关追加 `/v1/messages`。密钥保存后不回显，可留空保留或填写替换。停用或删除默认模型及其供应商前，先选择有效替代默认。配置更新从新请求生效，打开的成员目录自动更新；已有会话不会静默改用其他模型。成员保留共享模型选择、终端和自装插件，普通个人供应商配置操作关闭。

### 成员登出与恢复

DSH 内的受保护平台插件提供独立的「Log out」和「Restart instance」入口。登出只清除当前浏览器平台登录，已接受的任务继续执行。重启前须确认中断任务；成功后通过「Return to DSH」回到同一空间，配置、用户插件、聊天和文件保留。

即使 DSH 启动失败，有效成员凭据仍可登录平台并直接进入恢复页。DSH 无法加载时直接访问部署地址的 `/recovery`，仍可登出、重启并查看失败或成功反馈。配置损坏导致重启失败时，请管理员重置 DSH 环境。平台始终使用当前登录身份决定目标。平台插件文件在容器中只读，原生插件管理操作不能停用或卸载；成员仍能使用终端和安装自己的插件。此保护不承诺任意用户代码无法干扰本人 DSH。

### 管理员重置 DSH 环境

在成员管理页为已启用成员选择「Reset DSH environment」，确认中断运行任务后执行。即使成员无法打开 DSH，管理员仍可操作。平台先停止该成员实例，完成私有备份，再重置 web profile（含自装插件）、home patch/环境变量及尚未导入的旧 Settings，最后启动替代实例。空间 URL、项目、聊天和其他个人文件保留；尚无实例的成员也可通过该操作启动。

备份失败保留原配置；重置或启动失败会报告已完成备份及恢复信息，不伪报成功。备份位于平台数据根 `environment-backups/<spaceId>/<backupId>`，成员容器不挂载，可能包含私有配置和凭据。结果指向给部署者的 `README.txt` 及记录原有/原先不存在载体的 manifest。人工恢复须先停平台服务并核实目标容器已移除，将当前载体另存，再只恢复清单所列原配置，不能跟随符号链接。只停平台服务可能留下容器；恢复旧备份也会恢复原故障。旧备份不自动清理。

## 从 0.1.0 升级

先停平台服务，私下保存一致的账户数据库、受保护环境配置、平台状态和用户存储备份；保留原 session secret、共享模型凭据和服务身份。用精确的 0.1.1 完成版本或校验过的候选包运行安装器，沿用部署路径和配置。启动仅移除属于该平台数据根的容器。已有管理员不会重新开放初始化；账户一次性获得稳定空间 URL，原目录映射保留。Cookie 格式变化可能要求原浏览器重新登录。

旧成员首次进入新版 DSH 前，平台先在成员挂载之外备份 web profile、home patch/环境变量及待导入的旧 Settings。备份失败则阻止原生启动，保留原配置；修复存储后重试。私有升级回执避免重复备份，之后由 DSH 执行自己的迁移；平台不会为启动成功而删除聊天和其他个人文件。升级提示要求受影响会话选择已启用的共享模型，不静默改变原会话模型。普通个人供应商操作退出正常入口，旧配置保留在私有备份。其他用户插件继续保留；不兼容插件导致无法进入时，通过独立恢复页及管理员环境重置处理，先备份坏 profile 再重置插件条目，保留插件文件供人工修复。

实际部署的共享模型及真实密钥只导入一次；以后管理员修改优先于旧环境默认值，重复安装也不覆盖。不要用样例值替换。原生失败回合在选定有效共享模型后先续跑，待其结束后再提交新任务。整版回退需要升级前一致备份和配套旧平台/镜像，单个环境重置备份不能代替整个平台降级。

本版固定的 DSH 已移除 `@deepseek-ai/dsh-invariants`。旧 profile 条目仍保留，原生插件管理器保留该条目但插件未激活，Web 界面仍可使用；若缺失插件使整个环境无法启动，则使用独立恢复页。管理员重置先备份原条目再移除。已验收的 `@aiwayds/dsh-web-search-tavily@0.6.0` 在升级后保持激活；重新开放访问前，检查其他插件与固定 DSH 的兼容性。

## 用户数据改盘

这是 Ubuntu 容器部署的显式停服操作。先自行准备并挂载新盘、配置开机持久挂载，工具不格式化磁盘。先在挂载点下创建归服务账户所有、模式0700的私有父目录，再在其中创建同权限的空目标目录（工具在目标旁暂存副本），不能选择挂载点本身，不能与平台根或源目录重叠，空间须容纳完整副本。源数据始终保留。

1. 按上文命令停止用户服务。编辑前私下备份 `/etc/dsh-phalanx/environment` 和平台状态。
2. 使用原受保护环境，以服务身份运行安装产物的工具。工具取得平台维护锁、移除自有容器、复制且不跟随链接，核验文件内容、类型、权限及链接文本，核验通过后才发布新绑定：

   ```sh
   sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) sh -c '
     set -a
     . /etc/dsh-phalanx/environment
     set +a
     exec /opt/dsh-phalanx/current/start migrate-user-storage \
       --target-root /mnt/new-data/dsh-phalanx/users --mount /mnt/new-data
   '
   ```

3. 成功后，仅将受保护配置的 `DSH_PHALANX_USER_DATA_ROOT`、`DSH_PHALANX_USER_DATA_MOUNT` 改为工具报告的目标和挂载点；保留所有凭据、平台根和原所有权。启动服务，核对已有空间的项目、聊天、个人文件和模型入口；主机重启后再次核对。

平台根 `storage-migrations/` 下保留私有 JSON 回执和恢复 README，含源、目标及原绑定。复制/核验失败不切换绑定；停服、保持原配置并重跑相同命令。绑定发布后尚未改配置时启动失败闭合，不生成空白替代环境。发布中断可核对保留源数据与目标后继续；已完成重试仅核对盘身份，不覆盖切换后的新文件。链接父目录、特殊文件、错误所有权、缺盘和不可写根会被拒绝，须显式修复。

回退先停平台并确认其用户容器已移除，只停服务可能留下容器。保留并对账切换后写入目标的文件，再返回源盘。恢复原受保护配置，并从回执 `previousBinding` 恢复原 `user-storage.json`（原先不存在时仅移除此绑定）；保留 `user-storage-identity`、源和目标副本及回执。原源盘为外置盘时恢复其挂载，重启核对原文件后再开放入口。遵循私有 README，不为绕过缺盘错误随意删除绑定。
