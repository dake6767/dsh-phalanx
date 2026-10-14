# 为技能配置平台代执行

[English](skill-execution.md) · [技能库](install.zh-CN.md#技能)

平台代执行让有资格的成员使用平台凭据调用管理员配置的命令。凭据保存在平台数据中，只进入执行进程。未明确配置为代执行的普通技能脚本，仍以成员权限运行。

## 共享运行依赖与成员命令

管理员在「运行依赖」中准备不带凭据的工具，再在技能详情的「运行依赖」页签选择引用。成员获得其有效技能授权和自选项所引用依赖的并集，也包括技能包；同名自装技能不会取消这项资格。撤销最后一项授权后，后续调用不再获得该命令，已经运行的进程可以继续使用原版本完成。准备产物以准备时相同的固定路径只读挂载。

平台启动成员实例时，PATH 依次优先使用平台代执行转发命令、共享依赖命令，然后是成员和系统目录。授权、依赖更新与撤销通过切换已挂载命令目录生效，无需重启实例；新 agent 会话和新开终端使用当前命令集合。交互终端可以通过自己的 `.bashrc` 调整顺序；agent 的非交互 bash 工具不读取 `.bashrc`，需要使用成员自装替代工具时，应指定其可执行文件的明确路径。

## 审阅与配置

导入并审阅技能，进入详情中的「平台代执行」。扫描只提供命令和变量建议，不会执行、证明其安全或自动保存。逐项确认后明确启用代执行。

代执行命令可以是准备后 PATH 上的可执行文件名，例如 `tencent-news-cli`，也可以是技能内相对脚本路径，例如 `scripts/mps_usage.py`；根目录脚本使用 `./query.sh`。可配置多个命令，每行有独立的禁用首参数。成员仍调用原命令或原脚本路径，平台转发参数、二进制 stdin、stdout、stderr 和命令退出码。

每个变量独立设置名称、值和「保密」。保密值只写不回显，保存后仅显示是否已配置；已有保密值留空表示保留，删除变量行才会移除。普通变量可见；将保密变量改为普通变量时需要重新输入值。平台拒绝保留的进程变量名。

## 腾讯新闻示例

先审阅上游技能归档和 CLI 安装器。配置代执行命令 `tencent-news-cli`、保密变量 `TENCENT_NEWS_APIKEY`，并将 `apikey-get`、`apikey-set`、`apikey-clear`、`update` 填入禁用首参数。

先新建运行依赖，将 PATH 目录设为 `bin`，再在技能的代执行配置中选择它。可用以下准备命令将 CLI 安装到不含凭据的准备目录：

```sh
mkdir -p bin &&
curl -fsSL https://mat1.gtimg.com/qqcdn/qqnews/cli/hub/tencent-news/setup.sh -o /tmp/news-setup.sh &&
TENCENT_NEWS_INSTALL="$PWD/.news" sh /tmp/news-setup.sh &&
cp .news/bin/tencent-news-cli bin/tencent-news-cli
```

该安装器 URL 是会执行的上游输入。部署时应审阅内容，选择可信版本或已校验下载。不要把真实 API Key 写入准备命令或共享 ZIP；在保密变量字段中保存。

等待准备就绪，先用「试运行」执行 `tencent-news-cli help`，再执行帮助中支持的查询，例如 `tencent-news-cli hot`。试运行使用管理员自己的空间，与成员调用共享授权、限制和审计路径。输入是命令及字面参数，不是 shell 程序；输出有长度上限。

首参数命中禁用列表时，不启动命令，返回退出码 `0` 和固定 stdout：

```text
API Key: Credentials are configured by the platform / 凭据由平台配置。
```

这是诊断占位提示，不是密钥。匹配只作用于第一个参数。管理员仍需判断 CLI 是否存在其他泄露途径，例如替代选项、嵌套命令、调试输出、写文件或上传网络。平台原样返回已执行命令的输出，不能替第三方程序作安全保证。

## 准备依赖与刷新

运行依赖在独立联网容器中准备，不注入平台凭据，也不挂载成员文件。准备从 `$RD_OUT` 开始，后续消费者使用同一个固定目录。声明相对 PATH 目录，也可填写检查命令；平台在新的只读容器中检查路径、链接和命令名后才发布版本。在「平台代执行」中选择一项或多项可用依赖，按引用顺序搜索各依赖声明的 PATH 目录。

凭据变量在代执行设置中配置，例如 `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`，以及普通地域或桶设置。修改变量后，下一次调用立即使用新值，不会重新准备依赖；已经接纳的调用继续使用原凭据和依赖版本快照。

修改依赖定义或运行时镜像会准备替代版本，也可在依赖详情中「重新准备」。准备期间及替代版本失败后，当前可用版本继续服务。更新技能保留代执行配置，消失的脚本路径会标为不可用。删除技能清理代执行配置和秘密变量；已接纳调用使用的源码和依赖会保留到调用结束。

已有技能级准备设置会自动迁移为运行依赖，并从代执行配置中删除。迁移后首次准备不注入凭据；失败时继续使用原私有安装产物，代执行页面会显示回退状态。检查生成的依赖及日志，再修复或重试。迁移生成的定义保留原准备命令需要的技能源码。技能、代执行配置或 MCP 服务仍引用某项依赖时，不能删除该依赖。

## 授权、限制与记录

管理员获得技能库中全部可用技能。其他成员可通过直接分组授权、技能包授权、已发布技能自选或已发布技能包自选获得资格。同名成员自装技能不会取消其平台代执行资格。每次调用重新检查账户及技能资格；停用账户或失去全部授权后，下一次调用会被拒绝。

安装模式下，每次调用创建独立 rootless 容器，挂载调用者的 home/workspace、处于原固定准备路径的只读依赖版本，只注入已配置变量，不透传成员环境变量。当前工作目录必须属于该成员空间，因此相对输出文件归调用者所有。命令允许访问网络。

默认每成员并发 2、全平台并发 8、单次超时 120 秒、内存 512 MiB、1 CPU、64 个进程，管理员在「系统设置」调整。准备另有十分钟期限。不支持 TTY 和交互式提示；stdin 在执行前一次读完。

「代执行记录」支持按成员和技能筛选。记录包含命令标识、结果和耗时，不记录参数、stdin、stdout、stderr 或凭据。记录保留 30 天，删除账户不会提前删除其审计记录。

## 错误码与开发模式

平台失败返回退出码 `125`，stderr 为以 `DSH_PHALANX_EXECUTION[code]` 开头的一行中英提示。命令自身失败则保留其退出码。

| 错误码 | 含义与处理 |
| --- | --- |
| `unauthorized` | 账户或技能资格已失效，检查成员状态及授权。 |
| `disabled` | 需要启用该技能的代执行。 |
| `not-ready` | 等待准备成功，或检查准备失败原因后重试。 |
| `command-missing` | 检查配置的命令及更新后的技能文件。 |
| `concurrency` | 等待已有调用结束，或检查并发限制。 |
| `timeout` | 调用超过时限。 |
| `invalid-directory` | 从调用成员的 home 或 workspace 内运行。 |
| `development-failed` | 检查开发主机上的执行环境与依赖。 |
| `internal` | 检查平台存储、进程清理及服务诊断。 |

仅在未配置容器且 Podman 不存在时，开发模式才回退到宿主进程；它不提供容器隔离或资源隔离，界面会显示该状态。有 Podman 时，准备和执行仍走容器。安装部署要求使用受支持的 Linux 容器路径。

## 贡献技能与所需命令

成员在自己的 DSH 会话中确认贡献。贡献声明列出所需 CLI 的名称、用途和安装说明，不含凭据或其他值。例如：

```json
{
  "purpose": "处理团队文档",
  "requiredCommands": [{
    "name": "lark-cli",
    "purpose": "读取团队文档；成员需自行登录",
    "installation": "将审核过的固定版本上游 Linux 发布安装到 $RD_OUT/bin。"
  }]
}
```

贡献者全局安装的 CLI 也必须声明：这些安装不会进入平台副本。不要把二进制打进技能。`SKILL.md` 可以保留缺失命令时安装的说明，平台提供的命令在 PATH 上优先。平台扫描脚本与 `SKILL.md`，发现调用了未声明、且用户实例镜像不提供的命令时发出警告，由成员修正或明确保留。扫描只提供提示，不保证发现所有调用。

管理员仍按审核、配置、分发三步采纳贡献。配置步骤按命令名匹配可用运行依赖并选中引用。缺少命令时，「准备此命令」打开按安装说明预填的新建依赖表单；请审核准备命令并声明 PATH 目录。准备通过后自动添加引用，也可改选提供该命令的其他已有依赖。所有声明命令均有可用依赖后才能采纳。更新贡献会标出命令需求的新增、移除项，已有引用保留，由管理员决定是否移除。

所需命令不会授予平台代执行权限；代执行命令白名单和凭据仍单独配置。读取历史或新传入声明时忽略旧字段 `execution.prepare`，不迁移、不预填。贡献者及其 agent 看不到运行依赖库。插件贡献声明不变。

## CLI 配置示例

以下示例面向 Linux amd64，使用固定的上游版本。保存前审查下载来源和准备命令。准备过程不带凭据，不要把密钥放进准备命令。npm 示例使用 `https://registry.npmmirror.com`，也可替换为部署者信任的仓库。Node.js 和 Python 由实例镜像提供；这些定义只安装工具，不管理语言运行时。

每个示例先创建对应的**运行依赖**，填入准备命令、PATH 目录和检查命令，等待**就绪**。在**技能**中导入并审查对应的上游技能，在其**运行依赖**页签选择该依赖。创建包含此技能的**技能包**，串联说明写明 CLI 由平台提供，无需执行安装和更新指引；保留上游任务操作说明。代执行工具还应说明凭据由平台提供，个人登录工具则保留上游登录指引。把技能包授权给成员分组，再用新会话验证，无需重启成员实例。

部署者可以读取用户数据根，包括成员保存在 home 中的个人凭据。平台代执行凭据保存在平台存储中，只注入单次隔离执行，不进入成员容器。第三方 CLI 输出原样返回，管理员仍需审查其命令和参数。

### OfficeCLI：成员侧编辑文件

运行依赖命名为 `office-tools`，PATH 目录填 `bin`，检查命令填 `officecli --version`。包装脚本先解析共享命令的符号链接，再定位二进制，并通过上游开关 `OFFICECLI_SKIP_UPDATE=1` 关闭自动更新检查。不要启用平台代执行。成员可以在 workspace 中创建和编辑 `.docx`、`.xlsx`、`.pptx` 文件。脚本需要立即读取保存结果时，设置 `OFFICECLI_NO_AUTO_RESIDENT=1`，或先执行 `officecli close <file>`。工具更新由管理员修改准备命令后执行。

```sh
set -eu
mkdir -p lib bin
curl -fL --connect-timeout 15 --max-time 180 https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157/officecli-linux-x64 -o lib/officecli
echo 'f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94  lib/officecli' | sha256sum -c -
chmod +x lib/officecli
cat > bin/officecli <<'SH'
#!/bin/sh
export OFFICECLI_SKIP_UPDATE=1
exec "$(dirname "$(readlink -f "$0")")/../lib/officecli" "$@"
SH
chmod +x bin/officecli
```

### MiniMax：代执行生成

运行依赖命名为 `minimax-tools`，PATH 目录填 `bin`，检查命令填 `mmx --version`。在**平台代执行**中启用命令 `mmx`，选择 `minimax-tools`，禁用首参数 `auth config agent update`，将 `MINIMAX_API_KEY` 保存为秘密变量。包装脚本只在隔离进程内把变量转成 CLI 的 `--api-key` 参数，固定区域为 `cn`，拒绝 `--base-url`、`--verbose` 和 `--region`，包括 `=value` 写法。在成员 workspace 中试运行 `mmx image generate --prompt "A blue circle" --width 512 --height 512 --n 1 --out sample-image.png`。生成会消耗上游额度，输出文件归成员所有。

```sh
set -eu
npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com mmx-cli@1.0.28
mkdir bin
cat > bin/mmx <<'JS'
#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const args=process.argv.slice(2);
if(args.some(arg=>/^(--base-url|--verbose|--region)(=|$)/.test(arg))){console.error('This option is disabled by the platform.');process.exit(2)}
const key=process.env.MINIMAX_API_KEY;
const extra=key?['--api-key',key]:[];
const result=spawnSync(process.execPath,[path.join(__dirname,'../node_modules/mmx-cli/dist/mmx.mjs'),...args,...extra],{stdio:'inherit',env:{...process.env,MINIMAX_REGION:'cn'}});
if(result.error){console.error('MiniMax CLI could not start.');process.exit(1)}
process.exit(result.status??1);
JS
chmod +x bin/mmx
```

### 飞书：代执行机器人身份

运行依赖命名为 `feishu-tools`，PATH 目录填 `bin`，检查命令填 `lark-cli --version`。在**平台代执行**中启用 `lark-cli`，选择 `feishu-tools`，禁用首参数 `config auth profile update`，将 `LARKSUITE_CLI_APP_ID` 和 `LARKSUITE_CLI_APP_SECRET` 保存为秘密变量。机器人身份无需成员登录。固定版本 CLI 优先选择环境凭据而不是 home 配置，但其环境认证模式不会自动用 App ID/Secret 换取 token。包装脚本从官方接口获取 tenant access token，仅通过子进程环境传递，不写入凭据文件，并固定飞书品牌和机器人身份。使用 `lark-cli api GET /open-apis/bot/v3/info --as bot` 验证。成员自己的 home 配置不能替换平台身份；每次代执行使用新建的临时 HOME。

```sh
set -eu
mkdir bin lib
curl -fL --connect-timeout 15 --max-time 180 https://github.com/larksuite/cli/releases/download/v1.0.98/lark-cli-1.0.98-linux-amd64.tar.gz -o lark.tgz
echo '4a12dcb7a0aab25986d8bcd046cb45b08278531a9aac3a12b53cf3d94738fe80  lark.tgz' | sha256sum -c -
tar xzf lark.tgz -C lib
rm lark.tgz
cat > bin/lark-cli <<'JS'
#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const path=require('node:path');
(async()=>{
  const env={...process.env,LARKSUITE_CLI_BRAND:'feishu',LARKSUITE_CLI_DEFAULT_AS:'bot',LARKSUITE_CLI_STRICT_MODE:'bot',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'};
  if(env.LARKSUITE_CLI_APP_ID && env.LARKSUITE_CLI_APP_SECRET){
    const response=await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:env.LARKSUITE_CLI_APP_ID,app_secret:env.LARKSUITE_CLI_APP_SECRET}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok || result.code!==0 || !result.tenant_access_token) throw Error('Bot token unavailable');
    env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN=result.tenant_access_token;
  }
  const child=spawnSync(path.join(__dirname,'../lib/lark-cli'),process.argv.slice(2),{stdio:'inherit',env});
  if(child.error)throw child.error;
  process.exitCode=child.status??1;
})().catch(()=>{console.error('Bot credentials could not be used.');process.exitCode=1});
JS
chmod +x bin/lark-cli
```

### 企业微信：成员个人登录

运行依赖命名为 `wecom-tools`，PATH 目录填 `node_modules/.bin`，检查命令填 `wecom-cli --version`。不要启用平台代执行或配置平台凭据。技能说明保留 `wecom-cli auth init`，由成员在终端执行并扫码授权，然后用 `wecom-cli auth status` 检查。个人认证数据留在该成员的 home 中。授权或更新共享 CLI 不会把个人登录态授权给其他成员。

```sh
set -eu
npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com @wecom/cli@1.3.4
```

### 使用 venv 准备 Python CLI

对于已审查的 Python CLI，使用镜像中的 Python，在固定准备路径内创建虚拟环境。将 `<reviewed-package>`、`<version>` 和 `<command>` 替换为审查过的包名、固定版本及其命令名。运行依赖的 PATH 目录填 `.venv/bin`，检查命令填 `<command> --version`。这里安装的是 CLI 环境，不安装或升级 Python；应选择与实例镜像中 Python 版本兼容的包。

```sh
set -eu
python3 -m venv --copies "$RD_OUT/.venv"
"$RD_OUT/.venv/bin/python" -m pip install \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  '<reviewed-package>==<version>'
```
