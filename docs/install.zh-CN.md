# Debian 系安装

[English](install.md)

支持有 sudo 权限的 Debian 系 amd64 主机；Ubuntu 24.04 与 26.04 已验证，其他同系列发行版未验证。安装器供给主机依赖、独立 rootless Podman 身份、随包运行时、已校验平台包及配套 DSH 镜像，无需开发用 Node.js、pnpm、GitHub CLI 或本地构建镜像。

## 主机要求

安装器根据主机的 `ID`、`ID_LIKE` 发行版系列字段准入，再检查能力。已验证名单包含 Ubuntu 24.04 与 26.04。其他 Debian 系主机会收到「未验证」警告，无需额外确认；通过能力检查不代表进入已验证名单。非 Debian 系主机在修改主机前被拒绝。

主机需要 **Podman 4.9.3 或更新版本**、**passt 0.0~git20240220 或更新版本**、systemd、可用的 user manager、cgroup v2，以及可工作的 rootless Podman。安装器先供给 apt 软件包，再检查能力。`pasta --version` 无法识别版本时，检查已安装 passt 软件包的版本。能力未知或低于要求时，诊断会指出要求及实际软件包版本并退出。能力检查失败可能留下已供给的系统软件包；全新安装此时尚未创建产品身份或部署配置。

`--bundle-dir` 离线包安装仅在已验证名单内的 Ubuntu 上保证可用，缺少系统依赖时仍需要可用的 apt 源。其他 Debian 系主机没有离线安装担保。各发行版的一次性验证记录见[版本说明](../releases/notes/)。

正式安装面向 Linux amd64。Linux arm64 的本地开发与验收见 [Mac 开发虚拟机](../CONTRIBUTING.md#mac-development-vm)。

## 公共稳定版本

已完成的稳定版本见 [Releases](https://github.com/dake6767/dsh-phalanx/releases)。运行：

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/install.sh && sudo bash install.sh
```

默认选择 GitHub 最新的已完成稳定 Release，排除预发布。指定版本使用 `sudo bash install.sh --version vX.Y.Z`。没有 curl 时可运行 `sudo apt-get update && sudo apt-get install -y curl`，也可通过浏览器下载独立脚本后传到主机。

平台归档和镜像 digest 来自同一 manifest，校验值、tag 提交、镜像身份必须匹配。镜像从 `ghcr.io/dake6767/dsh-phalanx` 按 digest 拉取。安装器不注册自动升级；正式发布时会验证匿名下载和镜像拉取。

安装无需模型密钥。首屏选择简体中文或English，默认中文；也可用
`--language en` 明确选择英文。首次查询版本前选择官方（默认）、中国大陆或
自定义下载源，语言不改变来源。先填写服务器访问IP与入口端口（默认18080），
再确认建议的HTTP浏览器地址，或改成实际HTTP/HTTPS域名；填写网址不会自动
部署证书或反向代理。方括号里是默认值，回车采用。高级网关与存储设置按需
展开，无效输入原地重填，摘要支持修改和取消。

端口转发/公网NAT单独声明，默认“没有”，回车确认。显式
`--host-public-addresses ''` 表示没有额外公网回连别名，允许正常公网访问，
继续保护宿主、私网、回环和声明的NAT目标；未声明仍阻止成员出网。
服务器访问IP和共享公网出口地址不能代替映射声明。

无人值守安装须提供明确配置并关闭终端问答：

```sh
sudo bash install.sh --non-interactive --language zh-CN \
  --public-origin http://192.0.2.10:18080 --host-public-addresses '' --output json
```

将示例网址替换为实际浏览器地址。JSON只选择结构化输出；
`--non-interactive` 才会在有终端时也关闭问答。升级中断仍需独立的 `--yes` 确认。

首次安装时如需独立成员数据盘，先挂载再安装，同时提供 `--user-data-root` 和 `--user-data-mount`。见[独立用户数据盘](operations.zh-CN.md#独立用户数据盘)。首次安装也可设置[下载源和出口代理](operations.zh-CN.md#下载源)。

主机需要指定内部网关端口时，使用 `--gateway-port PORT` 选一个空闲端口。默认是
3081。首次安装遇到默认端口占用时，安装器可选择并保存可用端口。显式指定或已保存
的端口须匹配。网关仅监听回环地址，重新安装沿用已保存设置。

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

通过受信入口验证初始化/登录、账户管理、原生流式响应和真实 WSS 帧；从外部确认后端、网关和实例端口不可达。开发者 HTTPS 验证见[贡献指南](../CONTRIBUTING.md)。

停止预览只停用 `dsh-phalanx-edge.service` 及安装器拥有的用户服务，保留配置和数据。退役时只删除本次单元、配置、证书与运行目录。平台按记录的发布和配置重启或恢复，不重启共享 nginx，也不清理其他身份的容器。

参考：[NGINX WebSocket 代理](https://nginx.org/en/docs/http/websocket.html)、[Host 转发](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。

## 初始化平台

在浏览器打开安装器输出的 `initializationUrl`。链接含秘密，有效期 24 小时。创建首管理员后链接失效。安装器在最终结果中显示该链接。

1. 在「平台数据库」保留「内置 PostgreSQL」，或选择「外部 PostgreSQL」。使用外部数据库时，填入连接信息并执行「测试连接」。需要 PostgreSQL 14 或更新版本，账户须拥有 `dsh_phalanx` schema，或有权创建该 schema。使用空 schema 或匹配的本平台数据库。选择 `verify-full` 可验证服务器证书和主机名，私有 CA 证书可上传或粘贴。TLS 模式与恢复要求见[运维指南](operations.zh-CN.md#数据库切换与密钥轮换)。
2. 填写用户名和密码，创建首管理员。邮箱可选。平台自动登录并打开可跳过的首个模型表单。
3. 保存一家供应商的密钥和一个启用的默认模型，或选择「暂时跳过，完成安装」进入 `/admin`。保存时校验配置格式。成员进入 DSH 后，可发一条消息确认模型是否能回答。跳过后仍可使用终端和工作区。供应商协议和模型设置见[共享模型](admin-guide.zh-CN.md#共享模型)。
   如果供应商已经保存、运行时配置发布失败，重新加载首次模型页面，选择「重试模型配置发布」。此操作复用已保存的供应商及修订号。部署者也可[预填首次模型表单](operations.zh-CN.md#预填首次模型表单)。
4. 打开「账户管理」创建成员账户。以该成员登录，确认能打开 DSH。管理员也可在成员行选择「切换到该成员 DSH」，输入成员密码验证入口。账户与用户空间的使用方式见[成员指南](member-guide.zh-CN.md)。

创建首个账户前需要另取初始化链接时，见[找回初始化链接](operations.zh-CN.md#找回初始化链接)。部署开始使用后，按[一致备份](operations.zh-CN.md#一致备份与整机迁移)保存恢复所需的文件和数据库，并单独离线备份匹配的主密钥。

## 后续指南

- [运维指南](operations.zh-CN.md)介绍备份、升级、存储迁移和恢复。
- [管理员指南](admin-guide.zh-CN.md)介绍账户、模型、DSH 功能和资源分发。
- [成员指南](member-guide.zh-CN.md)介绍 DSH、平台应用中心、文件和实例恢复。

## 安装输出与诊断

从最终摘要确认本机就绪并取得初始化链接。按报告的入口端口检查浏览器访问、
防火墙或安全组规则及反向代理。安装失败时保存数据和配置，修正报告指出的问题后
重试已验证的安装器。日志位置、JSON 输出和服务日志命令见[安装输出与诊断](operations.zh-CN.md#安装输出与诊断)。

## CLI 模拟体验

可从源码目录运行 `python3 scripts/install/preview.py` 演练安装问答。传
`--language en` 可切换英文。模拟仅展示流程和结果，其他部署命令见[部署命令模拟](operations.zh-CN.md#部署命令模拟)。

## 找原说明

<a id="存储布局"></a>

- [存储布局](operations.zh-CN.md#存储布局)

<a id="安全边界"></a>

- [安全边界](operations.zh-CN.md#安全边界)

<a id="主密钥备份"></a>

- [主密钥备份](operations.zh-CN.md#主密钥备份)

<a id="数据库切换与密钥轮换"></a>

- [数据库切换与密钥轮换](operations.zh-CN.md#数据库切换与密钥轮换)

<a id="一致备份与整机迁移"></a>

- [一致备份与整机迁移](operations.zh-CN.md#一致备份与整机迁移)

<a id="下载源"></a>

- [下载源](operations.zh-CN.md#下载源)

<a id="出口代理"></a>

- [出口代理](operations.zh-CN.md#出口代理)

<a id="独立用户数据盘"></a>

- [独立用户数据盘](operations.zh-CN.md#独立用户数据盘)

<a id="服务管理与恢复"></a>

- [服务管理与恢复](operations.zh-CN.md#服务管理与恢复)

<a id="卸载与恢复部署"></a>

- [卸载与恢复部署](operations.zh-CN.md#卸载与恢复部署)

<a id="用户数据改盘"></a>

- [用户数据改盘](operations.zh-CN.md#用户数据改盘)

<a id="recoverable-system-updates"></a>
<a id="可恢复的系统升级"></a>

- [可恢复的系统升级](operations.zh-CN.md#可恢复的系统升级)

<a id="office-预览字体"></a>

- [Office 预览字体](member-guide.zh-CN.md#office-预览字体)

<a id="下载产物"></a>

- [下载产物](member-guide.zh-CN.md#下载产物)

<a id="html-文件交互预览"></a>

- [HTML 文件交互预览](member-guide.zh-CN.md#html-文件交互预览)

<a id="成员自配技能-key"></a>

- [成员自配技能 Key](member-guide.zh-CN.md#成员自配技能-key)

<a id="在此浏览器中切换账户"></a>

- [在此浏览器中切换账户](member-guide.zh-CN.md#在此浏览器中切换账户)

<a id="成员登出与恢复"></a>

- [成员登出与恢复](member-guide.zh-CN.md#成员登出与恢复)

<a id="成员实例"></a>

- [成员实例](admin-guide.zh-CN.md#成员实例)

<a id="分组与插件"></a>

- [分组与插件](admin-guide.zh-CN.md#分组与插件)

<a id="平台应用中心与-mcp"></a>

- [平台应用中心与 MCP](admin-guide.zh-CN.md#平台应用中心与-mcp)

<a id="技能"></a>

- [技能](admin-guide.zh-CN.md#技能)

<a id="技能包与多技能导入"></a>

- [技能包与多技能导入](admin-guide.zh-CN.md#技能包与多技能导入)

<a id="git-来源与检查更新"></a>

- [Git 来源与检查更新](admin-guide.zh-CN.md#git-来源与检查更新)

<a id="管理员重置-dsh-环境"></a>

- [管理员重置 DSH 环境](admin-guide.zh-CN.md#管理员重置-dsh-环境)

<a id="私有候选验收"></a>

- [私有候选验收](../CONTRIBUTING.md#candidate-contract)

<a id="入口与持久状态"></a>

- [入口与持久状态](operations.zh-CN.md#存储布局)

<a id="配置与支持范围"></a>

- [配置与支持范围](#主机要求)

<a id="安装进度"></a>

- [安装进度](#安装输出与诊断)

<a id="私有-http-服务预览"></a>
<a id="usage-records"></a>
<a id="使用记录"></a>

原入口暂不可用，相关数据保留。
