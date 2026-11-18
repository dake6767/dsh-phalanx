# 运维指南

[English](operations.md) · [安装](install.zh-CN.md) · [管理员指南](admin-guide.zh-CN.md) · [成员指南](member-guide.zh-CN.md)

## 存储布局

`DSH_PHALANX_DATA_ROOT` 保存本机制品、生成的投影与运行期状态。默认数据根为 `/var/lib/dsh-phalanx/data` 时，用户空间位于 `/var/lib/dsh-phalanx/data.durable/users`，内置 PostgreSQL 位于 `/var/lib/dsh-phalanx/data.durable/postgres`。显式外部用户卷和 PostgreSQL 使用配置的位置。默认目录无需独立挂载；只有选择外部卷时才写入 `USER_DATA_ROOT`、`USER_DATA_MOUNT`。

| 层 | 持久内容 | 恢复要求 |
| --- | --- | --- |
| 平台数据库 | 账户、授权、设置、使用记录及加密的集成凭据 | 恢复一致的 PostgreSQL 备份 |
| 平台代码 | 分版本的平台程序、更新器和配套镜像 | 恢复匹配且已校验的发布字节 |
| 用户空间 | 成员文件、原生设置与私有重置备份 | 保留实际用户根及归属 |
| 可重建区 | `data` 下的本机制品、投影、缓存与运行文件 | 保留本机制品输入；投影可重新生成 |
| 本机运维状态 | 主密钥、数据库连接、部署设置及升级和维护回执 | 恢复匹配的受保护组合，主密钥另做离线备份 |

### 安全边界

平台使用 AES-256-GCM 信封加密。PostgreSQL 保存凭据密文和由独立主密钥包裹的数据密钥。记录身份和字段参与认证，密文不能直接搬到另一个字段使用。

信封加密防止数据库内容或数据库备份泄露时暴露平台秘密，不防平台主机被攻破，也不对能读取主密钥的部署者保密。同时取得数据库密文和匹配主密钥即可解密。成员自配密钥与文件由成员自行保管。所有备份都应私下保存；生成的投影不得包含平台供应商或集成秘密。

### 主密钥备份

主密钥文件为 `/var/lib/dsh-phalanx/keys/master.key`，数据库连接文件为 `/var/lib/dsh-phalanx/keys/database.json`。将主密钥单独离线备份，与数据库备份分开保存。同时保留受保护的数据库连接文件、部署环境及原权限。已安装的主密钥和连接文件归服务账户所有，权限为 `0600`。只核对已安装密钥的指纹、不输出密钥内容：

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start master-key-fingerprint --config-file /var/lib/dsh-phalanx/keys/database.json --data-root /var/lib/dsh-phalanx/data
```

丢失主密钥后无法解密已有秘密。秘密重置会清除受保护的平台凭据，要求重新登录和配置凭据，不能替代备份恢复。轮换后重新制作离线备份，并保留恢复操作仍需要的旧密钥与配置组合。

### 一致备份与整机迁移

记录恢复所需的数据库与匹配的主密钥、配置及成员目录。主密钥副本单独离线保管。

先停平台并确认成员容器已停止，再制作一致备份。冷备内置数据库时还须停止 PostgreSQL 服务；外部 PostgreSQL 须取得匹配的一致备份。将数据库、主密钥、连接文件、`/etc/dsh-phalanx/environment` 和实际用户根作为同一部署组合保留，维持归属和权限。

还须复制数据根中的本机制品，包括上传技能的文件和 ZIP、插件归档与准备时保留的原包、贡献包。SQL 引用和摘要无法重新生成没有下载源的上传原件。直接复制完整数据根最省事；只有在保留输入足以重建时，才可省略生成的投影、缓存及可重新生成的运行文件。

在目标主机恢复匹配的程序与镜像、数据库、密钥和连接配置、本机制品及用户空间。保留部署标识和卷 marker，不要在已有用户数据上初始化新平台。先恢复外部挂载，保持旧主机停机，再启动服务并核对管理员登录、成员进入、文件与各项能力。不要让两台主机同时连接同一平台数据库。恢复核验完成前保留原始备份。

升级器不备份用户空间。停平台并确认成员容器已停止后，将实际用户根归档到该根之外的私有存储。
已安装主机上的默认用户根可用以下示例：

```sh
sudo sh -c 'umask 077; tar --acls --xattrs --numeric-owner -cpf /path/to/private-backup/users.tar -C /var/lib/dsh-phalanx/data.durable/users .'
```

先创建私有备份目标；使用外部用户根时替换为实际配置路径。保留整个用户根，包括存储 marker
及环境重置备份。将归档与上面的匹配部署组合一同保存，核对归档可列出、可按原归属与权限恢复。
升级失败后的自动恢复不能代替这份备份。

### 数据库切换与密钥轮换

外部 PostgreSQL 须为 14 或更新版本，数据库账户须拥有或有权创建平台的 `dsh_phalanx` schema。使用空 schema 或匹配的本平台数据库，其他产品的对象会被拒绝。`verify-full` 验证服务器证书与主机名，`require` 只加密而不验证证书，`disable` 不加密；TLS 失败不会回退明文。

切换到外部库前，私下准备 `/var/lib/dsh-phalanx/keys/database-target.json`，填写所选连接字段（`host`、`port`、`database`、`username`、`password`、`tls`，需要时填写 `ca`），归 `dsh-phalanx` 所有、权限 `0600`。不要放进数据根，也不要把口令写进命令参数。托管命令使用当前安装配置：

```sh
sudo /opt/dsh-phalanx/current/start database-switch --target external
sudo /opt/dsh-phalanx/current/start maintenance-status
sudo /opt/dsh-phalanx/current/start database-switch --target builtin
sudo /opt/dsh-phalanx/current/start master-key-rotate
sudo /opt/dsh-phalanx/current/start maintenance-status
```

在维护窗口逐次执行，每次完成后再启动下一项。切换会复制、核对平台事实后再选择目标，保留原库；轮换重新包裹数据密钥。两者会中断成员任务，并有独立维护回执。检查结果后，可用 `maintenance-recover` 继续可恢复的中断操作；按恢复指引处理，不手改连接文件或删除维护标记。新部署核验完成前保留源库与恢复文件。

轮换要求已选择数据库且平台 schema 已初始化；此时尚未创建首管理员也可轮换。未选择或未初始化时，命令在进入维护、关闭准入和停止服务之前拒绝，不改部署标识、数据库口令或数据密钥。

若旧执行器曾在初始化前轮换失败，`maintenance-status` 显示 `master-key-rotate` 的 `working` 阶段，先使用支持此恢复流程的已验证安装器更新独立执行器，再恢复：

```sh
sudo bash install.sh --upgrade bootstrap
sudo /opt/dsh-phalanx/current/start maintenance-status
sudo /opt/dsh-phalanx/current/start maintenance-recover
sudo /opt/dsh-phalanx/current/start maintenance-status
```

该流程保留当前平台版本。只有同一部署、同一源版本和匹配维护标记，且受保护配置和主密钥可认证、数据库仍未选择或 schema 为空、没有产品维护日志或密钥暂存文件时，才按此旧失败恢复。对已选但空 schema 的部署，执行器先在维护和准入仍关闭时，使用原版本数据库与存储 owner 补齐首次初始化所需的存储身份；该准备可中断重试，既有外部存储保护不变。未选库不做数据库初始化。随后启动原服务、验证健康入口并复核文件身份，schema 已就绪时再验证 `/readyz`，然后开放准入，结果为 `restored`。恢复中断可重试；文件变化、其他阶段或其他维护操作不会走此捷径。已有产品维护日志仍按原操作恢复流程处理。失败时保留维护状态及诊断，不手动删除标记。

## 服务管理与恢复

在已安装 Linux 主机使用全局部署管理命令：

```sh
sudo dsh-phalanx status
sudo dsh-phalanx stop
sudo dsh-phalanx start
sudo dsh-phalanx stop --yes --language en --output json
```

`status` 只查询，分项显示平台、成员实例、内置数据库和升级维护任务；部分残留或查询失败会返回非零退出码。`stop` 会中断成员任务，交互终端要求确认，自动执行时须明确传入 `--yes`。它停止本部署可核实归属的服务、成员容器及独立维护任务，保留数据、密钥和原开机自启设置。外部数据库、共享 HTTPS edge 和其他部署的资源分别管理。`start` 使用原配置启动，按现有常驻策略恢复成员实例；已中断的任务不会自动续跑。重复启动或停止已经达到目标状态的部署不会重启组件。

安装、升级或数据库维护正在进行时，启动和停止会拒绝冲突操作；先完成或恢复原操作，再重试。部分停止失败时查看分项结果，修复条件后可重复执行；不要把部分成功当作整套停机完成。

### 卸载与恢复部署

```sh
sudo dsh-phalanx uninstall
sudo dsh-phalanx uninstall --purge
```

默认卸载会停止部署、移除受管程序和服务，并解除部署的开机自启。成员空间、
平台数据库、匹配的主密钥、受保护配置和恢复记录会成套保留。卸载结果会给出
原版本。用该版本的已验证安装器和制品运行
`sudo bash install.sh --version <报告的版本>`，可恢复原部署。
重新安装会先核对保留的配置和密钥。

明确选择 `--purge` 后，命令会在确认前列出清理范围，删除已核验归属的本地
部署数据，包括内置数据库和外置卷内本部署的专用成员目录。默认卸载后，
可用已验证安装器运行 `sudo bash install.sh --uninstall --purge` 清理保留数据。
外部 PostgreSQL、系统账户、依赖、共享资源和挂载卷本身保留。请保持配置的
数据卷已挂载。如果卸载前数据库无法核实外置成员目录的归属，先恢复原部署并
启动，再验证该绑定后清理。非交互执行用 `--yes` 明确确认影响。

非零退出表示尚未完成。修正报告中的条件后重试同一命令。全局入口已移除时，
用对应的 `install.sh --uninstall` 命令接续。

以下底层命令仅操作平台用户服务，适合配置修改后的重启：

```sh
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user status dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user restart dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user stop dsh-phalanx.service
sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user start dsh-phalanx.service
```

stop 不取消开机启动。相同前缀下用 `systemctl --user disable --now` 暂停启动，`enable --now` 恢复。HTTPS edge 单独管理，不为操作平台而重启共享 nginx。

修改已有配置时，用 sudo 编辑 `/etc/dsh-phalanx/environment`，再重启该服务。保留所有权和 0640 权限；此文件包含受保护的部署参数，应私下保管。现行共享模型密钥和会话凭据保存在 PostgreSQL。一致性备份前停服，保存受保护配置、平台根与用户根及原权限。普通重启重建自有容器，保留原生配置、文件和成员容器主机名。升级时继承已有自有容器的主机名；备份或迁移安装时应保留私有平台数据根。平台能确认持锁实例已退出且锁仍属于该实例时，会恢复 DSH 网页配置写锁。归属或状态不明确的锁会保留。其他类型的锁按应用自身流程恢复。删除账户保留文件。需要清理本部署本地数据时，参见上面的卸载流程。

安装失败时保留配置及数据，修复所报告的网络、依赖或端口问题，用同一已验证版本重试。归档哈希不符须重新获取原始配套资产，不能编辑校验清单。激活失败会自动恢复；主动回退需要此前完成版本、配套镜像/配置及升级前的一致备份。不提供新版 DSH 已写数据的自动反向迁移。

## 独立用户数据盘


系统服务的默认平台数据根仍为 `/var/lib/dsh-phalanx/data`，默认用户根为 `/var/lib/dsh-phalanx/data.durable/users`。新部署先挂载数据盘并配置开机挂载，再运行：

```sh
sudo bash install.sh --version vX.Y.Z --user-data-root /mnt/data/dsh-phalanx-users --user-data-mount /mnt/data
```

安装器为新建或空目录设置服务账户归属和 0700 权限，不自动接管非空目录。
两个选项须同时提供，保存为受保护配置中的 `DSH_PHALANX_USER_DATA_ROOT` 与
`DSH_PHALANX_USER_DATA_MOUNT`。容器模式要求独立盘实际挂载于指定挂载点，
不能用系统盘普通目录或父目录挂载代替。开发模式允许宿主目录，但不提供容器隔离。
外部用户根
不能与平台数据根重叠。平台不会格式化磁盘、代管挂载或递归修改已有数据权限。

平台数据库保存持久存储标识与所选卷的绑定，卷上的 `.dsh-phalanx-storage.json` marker 标识对应卷。恢复时须将数据库、匹配密钥与连接配置、用户卷一并恢复；即使在
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

## 用户数据改盘


这是已安装容器部署的显式停服操作。先自行准备并挂载新盘、配置开机持久挂载，工具不格式化磁盘。先在挂载点下创建归服务账户所有、模式0700的私有父目录，再在其中创建同权限的空目标目录（工具在目标旁暂存副本），不能选择挂载点本身，不能与平台根或源目录重叠，空间须容纳完整副本。源数据始终保留。

1. 按上文命令停止用户服务。编辑前私下备份 `/etc/dsh-phalanx/environment` 和平台状态。
   离线操作期间须保持 PostgreSQL 可连接。停止平台也会停止内置数据库；使用内置库时，先只启动数据库服务：

   ```sh
   sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) \
     systemctl --user start dsh-phalanx-postgres.service
   ```

   使用外部 PostgreSQL 时，保持现有数据库服务运行。
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

私有 JSON 回执和恢复 `README.txt` 位于受保护数据库连接配置同目录的 `storage-migrations/`，不放在平台数据根中；记录源、目标以及原 SQL 绑定和 revision。复制或核验失败不切换绑定；停服、保持原配置并重跑相同命令。绑定发布后尚未改配置时启动失败闭合，不生成空白替代环境。目标已发布经核验的 marker 后，重跑只继续 SQL 发布，保留目标后来新增的文件；已完成的重跑仅核对卷，不再复制。链接父目录、特殊文件、错误所有权、缺盘和不可写根会被拒绝，须显式修复。

回退先停平台，另存并对账切换后写入目标的文件。重跑以上命令，增加 `--rollback`，并保持**原来的 `--target-root` 和 `--mount` 参数**。工具只清理自有载体，校验保留源后以 revision 比较恢复原 SQL 绑定；若此后发生其他换卷则拒绝。两个目录均不重拷、不删除。启动前恢复原受保护环境；回退结果 `targetMount: null` 表示原先使用默认存储，应移除两个显式用户数据设置。保留平台存储身份、两份目录及私有回执。原源盘为外置盘时恢复其挂载，重启核对原文件后再开放入口。遵循回执恢复指引，不为绕过缺盘错误删除绑定事实。

## 下载源

在「系统设置 → 下载源」选择「官方」或「中国大陆」，然后按需逐项修改。类别包括 npm、PyPI、Docker Hub/GHCR 镜像、GitHub 资产、GitHub API 和浏览器。首次安装默认为「官方」。受保护的已保存配置供运行依赖准备和后续升级复用；切换预设会重置逐项覆盖。镜像和 GitHub 前缀留空表示直接访问。

```sh
sudo bash install.sh --download-source-preset mainland
```

安装还支持 `--npm-registry`、`--pypi-index`、`--container-mirror`、`--ghcr-mirror`、`--github-proxy-prefix`、`--browser-download-host`。地址不得包含凭据；容器镜像地址必须使用 HTTPS。`--github-api-proxy-prefix` 设置 GitHub API 前缀。从 GitHub 添加插件时，预检经 API 前缀解析默认分支、经资产前缀下载源码；安装与升级只读取发布资产，不使用 API 前缀。命令行选择作用于本次操作；首次选择会保存，已有管理员配置仍作为后续操作的默认值。

「中国大陆」预设使用 npmmirror npm、清华 PyPI、DaoCloud Docker Hub、南京大学 GHCR、ghfast GitHub 资产、gh-proxy.org GitHub API。浏览器使用 npmmirror，镜像路径缺口通过独立 Chromium 地址覆盖，见[运行依赖准备](skill-execution.zh-CN.md#准备依赖与刷新)。镜像属于外部服务，可能不可用，必要时修改相应类别。下载源改变获取路径，发布身份、校验值和镜像 digest 校验仍会执行。

平台的 npm 下载源控制受管插件准备及其 registry 预检。DSH 原生插件管理器保留独立的 registry 选择，包括 npmmirror；修改平台配置不会改写原生选择。

### 出口代理

安装、CLI 和管理页升级、镜像拉取、Git 导入及运行依赖准备均遵循 `HTTPS_PROXY` / `https_proxy` 与 `NO_PROXY` / `no_proxy`。两种大小写同时存在时，小写优先。首次安装先导出变量，再通过 sudo 保留：

```sh
sudo --preserve-env=HTTPS_PROXY,https_proxy,NO_PROXY,no_proxy bash install.sh
```

代理 URL 带凭据时，通过私有终端输入或受保护文件提供，不要写入命令历史、技能 URL 或诊断报告。安装器把配置保存到部署者持有的受保护 systemd 环境文件 `/etc/dsh-phalanx/environment`，供平台服务和更新器共用。后续操作以已保存配置为准，优先于当前 shell 环境。编辑文件后，重启 `dsh-phalanx.service` 和 `dsh-phalanx-updater.service`。将 `HTTPS_PROXY` 设为空可停用已保存代理。`NO_PROXY` 保留逗号分隔的排除项，并始终包含回环主机；私有网关和预览流量保持本地直连。部署者代理凭据不会复制到成员环境或准备日志。

下载源前缀决定访问哪个地址，出口代理决定流量如何到达该地址，两者可以同时配置。受信下载进程也会将 HTTP 目标（包括 Ubuntu 软件源）交给该代理。代理失败会提示检查 `HTTPS_PROXY` / `NO_PROXY`，不打印凭据。Git 还可用 `GIT_SSL_CAINFO` 指定自定义受信 CA。安装器供给 Git，升级准备阶段发现缺少 Git 时会补装。

## 可恢复的系统升级

版本可以声明需要全新安装。此时检查更新会拒绝原地升级，不提供下载或应用操作。先备份原部署和主密钥文件，再另行准备全新安装；在确认不再需要旧数据前保留原部署。当前安装器会在查询不支持的旧数据库之前拒绝升级。已安装的旧版页面可能只显示通用不兼容原因，请按发布说明中的安装指引操作。

兼容的原地升级会先停止旧平台及自有实例，再导出全部已登记 PostgreSQL schema，并备份
密钥、连接配置、部署配置和数据库服务单元。导出工具与所选服务器主版本相同，在停机前准备完成。
迁移或验证失败时，先一起恢复这些内容，再启动旧版本；无关数据库 schema 不在恢复范围内。
用户空间文件不进升级备份，须按上文方法另做一致备份。旧工作全部排空后，验证阶段只读
检查用户存储，提交前不启动成员或常驻实例。可重建制品与投影树原地沿用，维护期间不回收；
恢复会先核对记录的目录仍然存在，再替换平台数据。升级成功或恢复完成后删除本次临时备份；
恢复失败则保留备份，维护状态保持关闭。

停机期间，成员看到按浏览器语言显示的「系统升级中」页面；页面检查就绪状态，完成后自动刷新。
现有 WebSocket 会话会断开。旧安装版本若没有打包维护页，目标监听器启动前可能显示连接重置。
验证期间成员工作始终关闭，就绪响应本身不会提前放开业务。

系统升级模块按当前状态展示可执行操作，包括先更新到断点版本、候选部署转为同号正式版。
应用前须确认任务会中断、成员文件不在升级备份范围内。执行期间展示阶段和已停机时长，
完成后展示停机总时长及各阶段耗时。已知诊断按平台语言显示；未知错误保留原文及受限的服务器日志路径。

升级执行器会在数据库工具或平台包下载、解压、镜像导入和停服前，检查缓存、平台程序、
rootless 镜像层及下载暂存、平台数据和备份各自所在的实际文件系统。
同盘位置共用一份可用空间，所需空间保守累计新增写入；已存在的镜像不重复预留镜像层。
目标镜像不同，仅扣除与已验证当前镜像相同的连续层前缀；离线导入仍预留整包暂存空间。
容量信息缺失或空间不足时，准备过程失败，当前服务保持运行。升级页面和 JSON 操作结果
展示所需、可用、缺少的字节数，以及包含数据库导出估算的备份容量。应用升级前还会再次检查；
检查之后的其他磁盘写入仍可能改变可用空间。

首次下载前、升级验证成功并重新开放服务后，更新器会回收安装回执与镜像身份能证明归属的资源。
保留当前版本和最近一个成功使用的旧版本、已准备目标及未完成恢复所需资源；保护所有运行或停止
容器的引用与运行进程所引用的程序。经验证的历史升级备份会删除；当前操作仍受保护，直到本次
升级成功或恢复完成后释放其备份。未知归属资源、用户数据和恢复执行器保持不动。
清理后重新测量容量，不会为凑足空间而突破保留策略。

系统升级页展示实际观测到的释放量和各资源的保留原因，不将共享层或多个镜像名称重复计算。
升级成功与清理失败分别记录；**重试清理**只重试资源回收，不再次升级、停服或还原旧数据。
服务端也可运行 `sudo bash install.sh --upgrade cleanup --output json`。
中断的清理可从持久化操作继续。保留旧制品是应急储备，不代表支持在新数据写入后任意降级。

如果已安装的执行器不支持所选发布协议、验收检查项或该版本要求的恢复能力，先按安装说明重新下载当前安装器。
不要复用旧脚本；它可能在下载新版执行器前就拒绝新的契约。然后执行
`sudo bash install.sh --upgrade bootstrap --version latest --output json`。
该命令验证发布身份，仅从对应发布提交下载有校验和约束的小型执行器模块，
重启升级执行器，平台继续运行。完成后返回系统升级页面。
已有准备完成或中断的升级操作必须先完成或恢复。使用当前 CLI 安装器直接准备升级，
也会执行容量检查。

部分旧安装在首次受支持的原地升级前，需要执行一次上述 bootstrap。
具体过渡步骤见目标[发布说明](https://github.com/dake6767/dsh-phalanx/releases)；后续只有执行器不满足目标声明的最低读者版本
或所需能力时才需要再次执行。



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

发布声明给出兼容 schema 区间、升级下限、断点和最低执行器读者版本。
满足最低读者的执行器容忍未知字段、更高协议号及新增渠道属性，仍校验已知兼容要求与制品完整性；
不满足时，须先用上述已验证安装器更新执行器。不支持的来源 schema 或原生环境改造在切换前被拒绝。
版本列表会指出须先更新到的断点，不直接应用不兼容的最新版。候选部署可通过正常升级事务转为同号正式版，
提交后才更新渠道。不支持任意历史降级。
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

## 安装输出与诊断


默认输出中文完成摘要，重定向时也一样；通过 `--language en` 选择英文。阶段、耗时、真实下载字节、镜像/依赖日志和等待
提示写 stderr，不估计总体百分比。自动化应提供明确部署参数，并传 `--non-interactive --output json`；stdout 仅有一份最终
结果；失败有结构化结果及非零退出。`--verbose` 提供脱敏命令与产物身份。

每次运行在 `/var/log/dsh-phalanx/` 保存脱敏阶段 JSONL，目录0700、文件0600。失败显示日志
位置、服务状态、可用的服务日志片段和可复制诊断命令。初始化链接仅出现在部署者最终
结果，凭据、密钥、授权载体不进入诊断输出或持久日志。

本机就绪不等于公网可达，请检查入口端口、防火墙/安全组及已有反代路由。

服务失败时，先看安装器报告，再按服务单元与 UID 查询日志：

```sh
sudo journalctl _SYSTEMD_USER_UNIT=dsh-phalanx.service _UID="$(id -u dsh-phalanx)" -n 100
```

### 部署命令模拟

可在 macOS 或 Linux 上，从源码目录用 Python 3 运行模拟器。命令输出模拟结果，
不操作已安装部署或其文件。

```sh
python3 scripts/install/preview.py start
python3 scripts/install/preview.py stop
python3 scripts/install/preview.py uninstall --purge
python3 scripts/install/preview.py status --state partial --output json
```

## 找回初始化链接

取回现有链接或重新生成（使旧链接失效）：

```sh
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080
sudo -u dsh-phalanx /opt/dsh-phalanx/current/start bootstrap-link --data-root /var/lib/dsh-phalanx/data --origin http://192.0.2.10:18080 --renew
```

替换为实际浏览器 origin。初始化后两条命令只返回 `/admin`，不能重开首管理员入口。

### 预填首次模型表单

部署者可在 `/etc/dsh-phalanx/initial-model.json` 写入 UTF-8 JSON 对象，最多
16 KiB。可填 `name`、`baseUrl`、`apiFormat`、`model`、`apiKey`。
`apiFormat` 可选 `anthropic-messages`、`openai-completions` 或
`openai-responses`。缺少的字段由管理员填写。

```json
{
  "name": "Example provider",
  "baseUrl": "https://models.example.com/v1",
  "apiFormat": "openai-completions",
  "model": "example-model",
  "apiKey": "<credential>"
}
```

使用权限为 `0600` 的普通文件，归平台运行账户（通常为 `dsh-phalanx`）所有，
父目录须能让该账户遍历。平台按实际读取的文件描述符检查归属、权限和大小。文件无效或
不可读时，可手动填写或跳过。浏览器只显示预填密钥状态。密钥栏留空使用预填值，输入
新值则替换。请在文件或表单填写密钥，避免出现在 URL 参数中。

保存后以 PostgreSQL 中的配置为准；跳过时不会导入配置。此文件在初始化后仍由部署者
保管。

## 此前配置的服务预览

服务预览入口暂不开放。保留既有配置。迁移或恢复已有部署时，预览监听及 origin 随受保护配置保存，独立证书和代理仍归部署者管理。
