# Ubuntu 安装

[English](install.md)

支持 Ubuntu 24.04 LTS amd64，须有 sudo 权限。安装器供给主机依赖、独立 rootless Podman 身份、随包运行时、已校验平台包及配套 DSH 镜像，无需开发用 Node.js、pnpm、GitHub CLI 或本地构建镜像。

## 公共稳定版本

已完成的稳定版本见 [Releases](https://github.com/dake6767/dsh-phalanx/releases)。运行：

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

默认选择 GitHub 最新的已完成稳定 Release，排除预发布。指定版本使用 `sudo bash install.sh --version vX.Y.Z`。没有 curl 时可运行 `sudo apt-get update && sudo apt-get install -y curl`，也可通过浏览器下载独立脚本后传到主机。

平台归档和镜像 digest 来自同一 manifest，校验值、tag 提交、镜像身份必须匹配。镜像从 `ghcr.io/dake6767/dsh-phalanx` 按 digest 拉取。安装器不注册自动升级；正式发布时会验证匿名下载和镜像拉取。

安装无需模型密钥。确认浏览器访问地址（或用 `--public-origin` 指定）和全部公网 IPv4，包括 NAT 别名；仅在没有公网 IPv4 时提交空清单。打开安装器输出的 `initializationUrl`，填写管理员用户名和密码后直接进入 `/admin`，邮箱可选。模型尚未配置时，终端和 workspace 仍可用。

在 Model management（`/admin/models`）添加共享模型供应商、密钥和独立模型行，显式保存。Messages Base URL 包含供应商前缀：DeepSeek 为 `https://api.deepseek.com/anthropic`，火山 Coding Plan 为 `https://ark.cn-beijing.volces.com/api/coding`；网关追加 `/v1/messages`。停用或删除默认模型及其供应商前，先选择启用中的替代默认。成员模型目录随配置更新，无需重启平台。

已有静态配置仍可传 `--model-key-file /path/to/key`，使用权限 0600 的受保护普通文件。默认 `latest` 不选择候选预览。

## 独立用户数据盘


系统服务的默认平台数据根仍为 `/var/lib/dsh-phalanx/data`，默认用户根为其下的
`users`。新部署先挂载数据盘并配置开机挂载，再运行：

```sh
sudo bash install.sh --version vX.Y.Z --user-data-root /mnt/data/dsh-phalanx-users --user-data-mount /mnt/data
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

## 入口与持久状态

全新安装默认监听 `0.0.0.0:18080`。确认或覆盖建议的局域网/公网 URL：安装器无法可靠发现云主机 NAT 地址，也不开放安全组端口、注册域名或配置证书。支持 HTTP，部署者可配置下文的 [HTTPS 反向代理](#自定义端口上的-https)。首次安装通过 `--listen-address`、`--port` 和 `--public-origin` 选择监听及访问地址。loopback 部署须自行转发端口，并明确提供对应的浏览器 origin。

初始化链接有效期 24 小时，普通服务重启保留，成功开户后消耗并自动登录。链接片段含秘密，只交给首管理员；安装器只在最终输出中显示，不写入安装回执。取回现有链接或重新生成（使旧链接失效）：

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080 --renew
```

替换为实际浏览器 origin。初始化后两条命令只返回 `/admin`，不能重开首管理员入口。

安装器管理 `/opt/dsh-phalanx/releases` 及 `current` 链接。受保护配置在 `/etc/dsh-phalanx/environment`，平台账户和默认用户文件在 `/var/lib/dsh-phalanx/data`。`dsh-phalanx` 服务账户运行平台及 rootless 容器，用户 systemd 单元通过 linger 在重启后启动，无需交互登录。AppArmor 保持启用，兼容 profile 仅作用于 Podman 和 pasta。

安装向导确认浏览器 URL 和入口端口，展示目录，并提供高级网关/存储设置。非交互执行须明确提供 `--public-origin URL --host-public-addresses COMPLETE_LIST`，确实没有公网别名时才传空清单。缺失或无效的必要信息在大型下载前失败。

首次安装失败后重跑向导，或提供修正参数（如 `--gateway-port 41081`）。安装器显示变更字段名，保留秘密和文件，复用校验通过的下载；无需为这类重试手改配置。成功安装后，同版同配置且健康时返回原入口，不重新部署或重启。冲突配置明确失败，已有配置及存储改动须显式停服维护。校验或依赖失败非零退出，激活失败时恢复原版本（若存在）。不要删除数据根来重试。

服务失败时查看安装器报告及日志：

```sh
sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 100
```

## 自定义端口上的 HTTPS

在平台前运行独立反向代理。[nginx 配置](../deploy/nginx/https.conf.example)和 [systemd 单元](../deploy/nginx/dsh-phalanx-edge.service.example)使用独立的 `dsh-phalanx-edge` 身份与进程，不影响其他 nginx 服务。明确的 HTTP/1.1 WebSocket 设置支持 NGINX 1.24 及以上。

配置 TLS 前，先用临时监听器确认外部端口可达。平台使用 loopback 监听，并配置含端口的准确 HTTPS origin。选择空闲私有网关端口（默认 3081）：

```sh
sudo bash install.sh --version vX.Y.Z \
  --host-public-addresses 198.51.100.10 \
  --listen-address 127.0.0.1 --port 18080 --gateway-port 41081 \
  --public-origin https://198.51.100.10:18443
```

示例公网地址须替换为主机完整 IPv4 清单。平台及配套镜像来自同一已验证发布。已有受保护配置须显式修改；重复执行安装器不会静默替换部署信息。

创建锁定密码、无登录 shell 的 edge 身份。证书的 Subject Alternative Name 必须覆盖浏览器使用的准确 IP 或域名。私钥保存在仓库外，仅 edge 身份可读。替换模板路径及地址，安装独立配置与单元，通过 `nginx -t` 后启用。单元提供自己的可写运行目录和优雅关闭。

私有测试 CA 的公共证书须导入每位测试者的信任库，并通过部署通道核对指纹；CA 签名私钥保留在部署工作站。证书日期、信任链和地址匹配必须正常验证，浏览器验收保持 `ignoreHTTPSErrors` 关闭。预览结束后移除该测试 CA 信任。公共部署使用正常受信证书并自行安排续期，模板不申请或续期证书。

代理保留含端口的 Host，并转发 Upgrade、Connection 以支持 WSS；关闭响应缓冲以支持流式响应。平台公开 origin 控制相对登录跳转和 Secure Cookie，后端仍为 loopback HTTP。模型网关和容器发布端口也保持 loopback。这里的 18080 仅供本机调试，对外入口为 HTTPS 18443。

通过受信入口验证初始化/登录、账户管理、原生流式响应和真实 WSS 帧；从外部确认后端、网关和实例端口不可达。`tests/https-preview.e2e.ts` 使用私有访问文件，保留部署管理员，只通过管理 API 删除自己创建的测试成员。

停止预览只停用 `dsh-phalanx-edge.service` 及安装器拥有的用户服务，保留配置和数据。退役时只删除本次单元、配置、证书与运行目录。平台按记录的发布和配置重启或恢复，不重启共享 nginx，也不清理其他身份的容器。

参考：[NGINX WebSocket 代理](https://nginx.org/en/docs/http/websocket.html)、[Host 转发](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。

## 私有候选验收


仓库和 registry 私有时，由发布者提供独立安装器及同一候选的四个原始资产：
`manifest.json`、`SHA256SUMS`、平台归档、OCI归档，经授权的私有通道传递。
发布者的 GitHub token 不写入脚本、不复制给验证机。

```sh
sudo bash install.sh --version vX.Y.Z-rc.N --bundle-dir /path/to/candidate
```

N 替换为精确候选编号。安装器完整校验两份归档并导入自己的 rootless 镜像存储，
不能用无关预加载镜像替代供给。公共版本使用匿名下载与配套 digest 拉取。

`--gateway-port PORT` 可选已有主机上空闲的私有网关端口，默认3081；首次安装默认端口占用时可自动选择空闲值并告知、保存。明确指定或已保存
的端口不会静默改变，始终 loopback；
重复安装保留此配置，拒绝冲突选项。HTTPS 后须设置含外部端口的完整公开 origin。
公网 IPv4 清单须完整，缺少部署事实时外部代理关闭。

## 服务管理与恢复

在 Ubuntu 主机运行以下命令，仅操作安装器的用户服务：

```sh
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user status dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user restart dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user stop dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user start dsh-phalanx.service
```

stop 不取消开机启动。相同前缀下用 `systemctl --user disable --now` 暂停启动，`enable --now` 恢复。HTTPS edge 单独管理，不为操作平台而重启共享 nginx。

修改已有配置时，用 sudo 编辑 `/etc/dsh-phalanx/environment`，再重启该服务。保留所有权和 0640 权限；配置含共享模型和会话凭据，不能贴入问题报告。一致性备份前停服，保存受保护配置、平台根与用户根及原权限。普通重启重建自有容器，保留原生配置和文件。删除账户保留文件；不提供自动数据擦除和灾难恢复。

安装失败时保留配置及数据，修复所报告的网络、依赖或端口问题，用同一已验证版本重试。归档哈希不符须重新获取原始配套资产，不能编辑校验清单。激活失败会自动恢复；主动回退需要此前完成版本、配套镜像/配置及升级前的一致备份。不提供新版 DSH 已写数据的自动反向迁移。

## 配置与支持范围

`bash install.sh --help` 列出首次安装参数：上游 URL/供应商/模型、受保护密钥文件、公网 IPv4 清单、监听及端口、准确公开 origin、私有网关端口。默认模型为 DeepSeek official 的 `deepseek-chat`，后端 `0.0.0.0:18080`，网关 loopback 3081，采用容器模式。`--gateway-port` 只改私有端口，不改绑定地址。HTTPS 后须提供含外部端口的准确 origin。完整公网 IPv4 清单用于拒绝用户代理访问宿主别名；缺少该信息则关闭外部代理访问。

安装器仅支持 Ubuntu 24.04 LTS amd64。[贡献指南](../CONTRIBUTING.md)描述 Mac 开发模式，不承诺容器隔离。Linux 测试验证容器行为，已有服务器不能证明全新安装。项目不提供开放注册、自动升级、多发行版安装或支持 SLA。候选验收和普通 CI 不等于完成公共发布验收。

### 成员登出与恢复

受保护平台插件在 DSH 侧栏账户菜单提供「Log out」和「Restart instance」。登出只清除当前浏览器平台登录，已接受的任务继续执行。重启前须确认中断任务；成功后通过「Return to DSH」回到同一空间，配置、用户插件、聊天和文件保留。

即使 DSH 启动失败，有效成员凭据仍可登录平台并直接进入恢复页。DSH 无法加载时直接访问部署地址的 `/recovery`，仍可登出、重启并查看失败或成功反馈。配置损坏导致重启失败时，请管理员重置 DSH 环境。平台始终使用当前登录身份决定目标。平台插件文件在容器中只读，原生插件管理操作不能停用或卸载；成员仍能使用终端和安装自己的插件。此保护不承诺任意用户代码无法干扰本人 DSH。

### 管理员重置 DSH 环境

在成员管理页为已启用成员选择「Reset DSH environment」，确认中断运行任务后执行。即使成员无法打开 DSH，管理员仍可操作。平台先停止该成员实例，完成私有备份，再重置 web profile（含自装插件）、home patch/环境变量及尚未导入的旧 Settings，最后启动替代实例。空间 URL、项目、聊天和其他个人文件保留；尚无实例的成员也可通过该操作启动。

备份失败保留原配置；重置或启动失败会报告已完成备份及恢复信息，不伪报成功。备份位于平台数据根 `environment-backups/<spaceId>/<backupId>`，成员容器不挂载，可能包含私有配置和凭据。结果指向给部署者的 `README.txt` 及记录原有/原先不存在载体的 manifest。人工恢复须先停平台服务并核实目标容器已移除，将当前载体另存，再只恢复清单所列原配置，不能跟随符号链接。只停平台服务可能留下容器；恢复旧备份也会恢复原故障。旧备份不自动清理。

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

## 安装输出与诊断


默认输出英文完成摘要，重定向时也一样。阶段、耗时、真实下载字节、镜像/依赖日志和等待
提示写 stderr，不估计总体百分比。自动化必须显式传 `--output json`，stdout 仅有一份最终
结果；失败有结构化结果及非零退出。`--verbose` 提供脱敏命令与产物身份。

每次运行在 `/var/log/dsh-phalanx/` 保存脱敏阶段 JSONL，目录0700、文件0600。失败显示日志
位置、服务状态、可用的服务日志片段和可复制诊断命令。初始化链接仅出现在部署者最终
结果，凭据、密钥、授权载体不进入诊断输出或持久日志。

本机就绪不等于公网可达，请检查入口端口、防火墙/安全组及已有反代路由。

<a id="recoverable-system-updates"></a>

## 可恢复的系统升级


早于当前版本的安装，请先阅读目标版本 release notes。升级保留现有端口和存储绑定。
应用更新会立即重启服务、打断所有运行任务，并可能丢失未保存内容。交互模式会要求确认；
无终端模式必须显式传入 `--yes`。

```sh
sudo bash install.sh --version vX.Y.Z --yes
sudo bash install.sh --upgrade prepare --version latest --output json
sudo bash install.sh --upgrade apply --operation <prepared-operation-uuid> --yes
sudo bash install.sh --upgrade status --output json
sudo bash install.sh --upgrade recover --output json
```

准备阶段在旧服务运行时下载并验证固定的兼容组合。应用操作始终使用已准备的目标，
不受 latest 后续变化影响。升级失败后，即使旧服务已恢复且验证成功，命令仍以非零状态退出。
恢复失败会保持维护隔离并显示服务器应急指引。保留受保护的操作日志和已验证备份，
查看诊断日志后重试恢复；不要手动删除维护标记或修改 `current` 来绕过失败事务。

协议 1 支持平台持久化迁移及已验证的恢复，要求 DSH 修订和用户环境 epoch 不变。
未知协议、不支持的来源 schema 或延后发生的原生环境改造会在切换前被拒绝。
不提供任意历史降级，也不默认复制成员的全部项目盘。
设计见[兼容性与备份决策](architecture.md#system-update-transaction)。

协议版本会安装独立的 root 服务 `dsh-phalanx-updater.service`。控制 socket
仅供本机受管服务身份使用，Web 平台仍以 `dsh-phalanx` 用户运行。已提交更新
不会因浏览器断开或 Web 服务停止而取消，可用上述 status 命令查询同一操作。
执行器无法启动时，使用已验证独立安装器的 recover 命令，并检查
`sudo journalctl -u dsh-phalanx-updater.service --no-pager`。修复已验证发布包时，
保留 root 所有的操作日志与执行器版本目录；恢复流程验证健康前保持维护入口关闭。

管理员从 **System settings**（`/admin/settings`）进入升级功能。**Check for updates**
手动查询固定项目发布来源，仅选正式版本；检查失败显示更新情况未知并标明检查时间。
**Download update** 在旧服务运行期间校验平台、镜像和执行器。**Apply update**
明确提示服务重启、全部运行任务中断和未保存内容风险；Cancel 保留已准备更新和原有任务。
确认后立即执行，即使仍有任务运行。

断线时保留操作 ID。刷新、关闭页面或 Web 服务停机不会取消已提交操作，页面会查询同一
操作，显示安装版本、验证后的真实运行版本、有限脱敏进度，并区分升级成功与恢复旧版。
普通成员没有更新和诊断 API 权限。Web 或 root 执行器不可用时，使用上述独立安装器应急命令。

## 安装进度


交互终端保留已完成阶段，当前动作原位刷新；重定向或能力有限的终端使用简洁追加
记录和低频等待提示，不输出光标控制序列。下载总量已知时显示真实数量与百分比，
未知时显示已有数量或耗时；阶段与总耗时分别标明。

详细脱敏诊断仍保存到输出指出的受限日志路径，`--verbose` 显示底层输出。
`--output json` 的 stdout 保持一份最终 JSON，过程写入 stderr。失败显示原因、
下一步及诊断路径。这些展示变化不改变确认、升级恢复边界或所选发布身份。
