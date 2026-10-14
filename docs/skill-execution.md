# Configure platform execution for a skill

[简体中文](skill-execution.zh-CN.md) · [Skill library](install.md#skills)

Platform execution lets an authorized member invoke an administrator-configured command with platform credentials. Credentials remain in platform storage and enter only the execution process. Ordinary skill scripts still run with member permissions unless explicitly delegated.

## Shared runtime dependencies and member commands

Administrators prepare credential-free tools in **Runtime dependencies**, then select them in a skill's **Runtime dependencies** tab. A member receives the union of dependencies from effective skill grants and selections, including skill packs. Same-name personal skills do not remove this eligibility. Removing the last grant removes the command from subsequent calls; a process already running may finish using its original version. Prepared files are mounted read-only at the same fixed path used during preparation.

The platform starts member instances with execution forwarders first on PATH, shared dependency commands next, and member/system directories afterwards. Grant, dependency-update and revocation changes switch the mounted command directory without restarting the instance; new agent sessions and newly opened terminals use the current command selection. An interactive terminal may change this order in its own `.bashrc`. The agent's non-interactive bash tool does not read `.bashrc`; use an explicit executable path when choosing a member-installed alternative there.

## Review and configure

Import and review the skill, open its details, then choose **Platform execution**. The scan offers command and variable suggestions; it does not execute them, prove their safety or save them automatically. Confirm each field and enable execution explicitly.

A command is an executable name on the prepared PATH, such as `tencent-news-cli`, or a script path relative to the skill, such as `scripts/mps_usage.py`. Use `./query.sh` for a root-level script. Multiple command rows may have separate blocked first arguments. Members invoke the normal command or original script path; platform forwarding preserves arguments, binary stdin, stdout, stderr and the command's exit status.

Variables have independent names, values and **Secret** switches. Secret values are write-only: after saving, the page shows whether a value is configured. Leaving an existing secret value blank retains it; remove its row to remove it. Plain variables remain visible. Changing a secret variable to plain text requires entering a new value. Reserved process variables are rejected.

## Tencent News example

Review the upstream archive and CLI installer first. Configure command `tencent-news-cli`, secret variable `TENCENT_NEWS_APIKEY`, and blocked first arguments `apikey-get`, `apikey-set`, `apikey-clear`, `update`.

Create a runtime dependency with PATH directory `bin`, then select it in the skill’s platform execution settings. A preparation command can install the CLI inside its credential-free prepared tree:

```sh
mkdir -p bin &&
curl -fsSL https://mat1.gtimg.com/qqcdn/qqnews/cli/hub/tencent-news/setup.sh -o /tmp/news-setup.sh &&
TENCENT_NEWS_INSTALL="$PWD/.news" sh /tmp/news-setup.sh &&
cp .news/bin/tencent-news-cli bin/tencent-news-cli
```

The installer URL is an upstream executable input. Review its content and select a trusted version or verified download for your deployment. Do not put the real API key in this command or a shared ZIP. Save the key in the secret variable field.

Wait for preparation to become ready. Use **Trial run** with `tencent-news-cli help`, then a supported query such as `tencent-news-cli hot`. Trial runs use the administrator's own user space and the same permissions, limits and audit path as member calls. The input is a command with literal arguments, not a shell program; output is bounded.

A blocked first argument does not start the command. It returns exit status `0` and this fixed stdout:

```text
API Key: Credentials are configured by the platform / 凭据由平台配置。
```

This is a diagnostic placeholder, never the key. Matching concerns only the first argument. Administrators must review other ways a CLI could reveal credentials: alternative flags, nested commands, debug output, file writes or network uploads. The platform returns executed command output unchanged and cannot certify third-party behavior.

## Prepare dependencies and refresh

Runtime dependencies are prepared in a separate network-enabled container without platform credentials or member files. Preparation starts in `$RD_OUT`, the fixed directory used by later consumers. Declare relative PATH directories and optionally a check command. The platform validates paths, links and command names in a fresh read-only container before publishing a version. Select one or more ready dependencies in **Platform execution**; their PATH directories are searched in selection order.

Configure credential variables on the execution settings, for example `TENCENTCLOUD_SECRET_ID` and `TENCENTCLOUD_SECRET_KEY`, plus plain region or bucket settings. Changing these values affects subsequent calls immediately and does not prepare dependencies again. An already admitted call retains its credential and dependency snapshots.

Changing a dependency definition or the runtime image prepares a replacement; **Prepare again** on the dependency retries manually. The current usable version continues serving during preparation and after a failed replacement. Updating a skill retains execution settings and reports missing script paths. Removing a skill clears its execution configuration and secrets; sources and dependencies used by admitted calls remain available until those calls finish.

Existing skill-level preparation settings migrate automatically into runtime dependencies and are removed from execution settings. The first preparation uses no credentials. If it fails, the previous private installation remains available, and the execution page reports that fallback. Review the generated dependency and its logs, then repair or retry it. A migrated definition retains the original skill source needed by its preparation command. Dependencies cannot be deleted while referenced by skills, execution settings or MCP services.

## Access, limits and records

Administrators receive available library skills. Other members qualify through direct group grants, granted packs, published skill selections or published pack selections. A same-name personal skill does not remove their platform execution eligibility. Every invocation rechecks current account and skill access; disabling an account or removing all access denies the next call.

Each installed-mode invocation runs in a fresh rootless container with the caller's home/workspace, read-only referenced dependency versions at their fixed preparation paths, and only the configured variables. Member environment variables are not forwarded. The current directory must belong to that member's space, so relative output files belong to the caller. Commands can access the network.

Default limits are two concurrent calls per member, eight platform-wide, 120 seconds per invocation, 512 MiB memory, one CPU and 64 processes. Administrators change them in **System settings**. Preparation has a separate ten-minute deadline. TTY and interactive prompts are unsupported; stdin is read completely before execution.

**Execution records** filters by member and skill. Records include command identity, outcome and duration, but not arguments, stdin, stdout, stderr or credentials. Retention is 30 days; deleting an account does not erase its retained records.

## Failure codes and development mode

Platform failures use exit status `125` and one bilingual stderr line beginning `DSH_PHALANX_EXECUTION[code]`. The command's own failures retain its own exit status.

| Code | Meaning / action |
| --- | --- |
| `unauthorized` | Account or skill access is no longer valid. Check membership and grants. |
| `disabled` | Enable execution for this skill. |
| `not-ready` | Wait for successful preparation or inspect its failure and retry. |
| `command-missing` | Review the configured command and updated skill files. |
| `concurrency` | Wait for existing calls or review configured limits. |
| `timeout` | The invocation exceeded its time limit. |
| `invalid-directory` | Run from the invoking member's home or workspace. |
| `development-failed` | Inspect development-host execution and dependencies. |
| `internal` | Inspect platform storage, process cleanup and service diagnostics. |

Development mode falls back to a host process only when no container is configured and Podman is absent. It provides no container isolation or resource isolation; the interface reports that state. When Podman is available, preparation and invocation use it. Installed deployments require the supported Linux container path.

## Contributed skills and required commands

A member confirms a contribution in their own DSH session. The declaration lists required CLI names, their purposes and installation instructions; it contains no credentials or other values. For example:

```json
{
  "purpose": "Work with team documents",
  "requiredCommands": [{
    "name": "lark-cli",
    "purpose": "Read team documents; the member must log in themselves",
    "installation": "Install a reviewed, pinned upstream Linux release into $RD_OUT/bin."
  }]
}
```

Declare globally installed CLIs too: those installations are absent from the platform copy. Do not bundle binaries with the skill. Instructions to install a missing command may remain in `SKILL.md`; platform-provided commands take priority on PATH. The platform scans scripts and `SKILL.md` for undeclared commands absent from its instance image and asks the member to resolve or explicitly retain warnings. This scan is advisory, not proof that every call was found.

Administrators review the contribution using the existing review, configuration and distribution steps. Configuration matches command names to ready runtime dependencies and selects their references. For missing commands, **Prepare this command** opens a new dependency form prefilled with the installation instructions; review the command and declare its PATH directories. Successful preparation adds the reference automatically. You can choose another existing dependency that supplies the command. All declared commands must be covered before adoption. Updating a contribution highlights added and removed command requirements and retains existing references until you remove them.

Required commands do not grant platform execution. Its command allowlist and credentials remain separate. The old declaration field `execution.prepare` is ignored when reading stored or incoming declarations; it is not migrated or prefilled. Contributors and their agents cannot see the runtime dependency library. Plugin contribution declarations are unchanged.

## CLI configuration examples

These Linux amd64 examples use reviewed, pinned upstream inputs. Review downloads and preparation commands before saving them. Preparation runs without credentials; never place a key in a preparation command. The npm examples use `https://registry.npmmirror.com`; replace it with your trusted registry if needed. The instance image supplies Node.js and Python; these definitions install tools, not language runtimes.

For each example, create the named **Runtime dependency**, paste its preparation command, enter the stated PATH directory and check command, and wait for **Ready**. Import the relevant upstream skill through **Skills**, review it, and select the dependency in its **Runtime dependencies** tab. Create a **Skill pack** containing the skill. Its orchestration note should state that the platform supplies the CLI and that installation/update instructions must not be run. Retain upstream task instructions. For delegated tools, add that credentials are supplied by the platform; for personal login tools, retain the upstream login instructions. Grant the pack to a member group and test in a new session. Changes take effect without restarting the member instance.

The deployer can read the user data root, including personal credentials that members save in their home directories. Platform execution credentials stay in platform storage; they are injected only into an isolated invocation and are absent from the member container. Third-party CLI output is returned unchanged, so review its supported commands and flags.

### OfficeCLI: member-side file editing

Use dependency `office-tools`, PATH directory `bin`, check `officecli --version`. This wrapper resolves the shared command symlink before locating the binary and sets the upstream `OFFICECLI_SKIP_UPDATE=1` switch, disabling its automatic update check. Do not enable platform execution. Members can create and edit `.docx`, `.xlsx` and `.pptx` files in their workspace. For scripts that immediately inspect the saved file, set `OFFICECLI_NO_AUTO_RESIDENT=1` or run `officecli close <file>` first. Keep tool updates under administrator-controlled preparation.

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

### MiniMax: delegated generation

Use dependency `minimax-tools`, PATH directory `bin`, check `mmx --version`. In **Platform execution**, enable command `mmx`, select `minimax-tools`, block first arguments `auth config agent update`, and save `MINIMAX_API_KEY` as a secret variable. The wrapper converts that variable to the CLI's `--api-key` argument inside the isolated process, fixes the region to `cn`, and rejects `--base-url`, `--verbose` and `--region`, including their `=value` forms. Test `mmx image generate --prompt "A blue circle" --width 512 --height 512 --n 1 --out sample-image.png` from the member workspace. Generation incurs upstream usage; its output file belongs to the member.

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

### Feishu: delegated bot identity

Use dependency `feishu-tools`, PATH directory `bin`, check `lark-cli --version`. In **Platform execution**, enable `lark-cli`, select `feishu-tools`, block first arguments `config auth profile update`, and save `LARKSUITE_CLI_APP_ID` and `LARKSUITE_CLI_APP_SECRET` as secret variables. No member login is needed for this bot identity. The pinned CLI selects environment credentials before home configuration, but its environment provider does not exchange App ID/Secret for a token. The wrapper obtains a fresh tenant access token from the official endpoint and passes it only through the child process environment; it writes no credential file. It fixes the Feishu brand and bot identity. Test with `lark-cli api GET /open-apis/bot/v3/info --as bot`. A member's own home configuration cannot replace this platform identity; the invocation uses a fresh temporary HOME.

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

### WeCom: member-owned login

Use dependency `wecom-tools`, PATH directory `node_modules/.bin`, check `wecom-cli --version`. Do not enable platform execution or configure platform credentials. Keep `wecom-cli auth init` in the skill instructions. The member runs it in their terminal and completes the QR authorization, then checks `wecom-cli auth status`. Personal authentication data remains in that member's home. Granting or updating the shared CLI does not grant a personal login to other members.

```sh
set -eu
npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com @wecom/cli@1.3.4
```

### Python CLI preparation with venv

For a reviewed Python CLI, use the image's Python to create a virtual environment inside the fixed preparation path. Replace `<reviewed-package>`, `<version>` and `<command>` with the reviewed package, pinned version and its executable. Set the dependency PATH directory to `.venv/bin` and its check command to `<command> --version`. This installs a CLI environment; it does not install or upgrade Python. Choose a package compatible with the Python supplied by the instance image.

```sh
set -eu
python3 -m venv "$RD_OUT/.venv"
"$RD_OUT/.venv/bin/python" -m pip install \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  '<reviewed-package>==<version>'
```
