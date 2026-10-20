# Configure platform execution for a skill

[简体中文](skill-execution.zh-CN.md) · [Skill library](install.md#skills)

Platform execution lets an authorized member invoke an administrator-configured command with platform credentials. Credentials remain in platform storage and enter only the execution process. Ordinary skill scripts still run with member permissions unless explicitly delegated.

## Shared runtime dependencies and member commands

Administrators prepare credential-free tools in **Runtime dependencies**, then select them in a skill's **Runtime dependencies** tab. A member receives the union of dependencies from effective skill grants and selections, including skill packs. Same-name personal skills do not remove this eligibility. Removing the last grant removes the command from subsequent calls; a process already running may finish using its original version. Prepared files are mounted read-only at the same fixed path used during preparation.

The platform starts member instances with execution forwarders first on PATH, shared dependency commands next, and member/system directories afterwards. Grant, dependency-update and revocation changes switch the mounted command directory without restarting the instance; new agent sessions and newly opened terminals use the current command selection. An interactive terminal may change this order in its own `.bashrc`. The agent's non-interactive bash tool does not read `.bashrc`; use an explicit executable path when choosing a member-installed alternative there.

Download defaults come from **System settings → Download sources**. Preparation receives the selected npm registry, pip/uv index and Playwright download hosts through private npm/pnpm configs and environment defaults. An explicit command option, such as `npm --registry=…` or `pip --index-url=…`, takes precedence. Logs list those defaults, the executed preparation and check commands (including explicit source choices) and its output; arbitrary scripts can still use their own addresses. After changing sources, use **Prepare again** to build a replacement; the previous usable artifact continues serving until replacement succeeds.

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

Wait for preparation to become ready. Use **Trial run** with `tencent-news-cli help`, then a supported query such as `tencent-news-cli hot`. Trial runs use the administrator's own user space and the same permissions, limits and usage-record path as member calls. The input is a command with literal arguments, not a shell program; output is bounded.

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

Open **Usage records → Tool usage** and filter by member and capability (`skill:<name>`). Records include the starting group, command, first argument, result, duration, exit code and failure reason where available. Other arguments, stdin, stdout, stderr and credentials are excluded. Retention defaults to 180 days and is configurable from 1 to 3650 days; deleting an account does not erase retained records early. See [Usage records](install.md#usage-records) for the three views and retention settings.

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

## Suite catalog

Open **Suite catalog** in the administrator navigation, after **Groups** and before **Plugins**. Filter between **Suites** and **Runtime dependencies**. A suite brings together a CLI, reviewed skills, a same-name skill pack and, where needed, delegated execution. Catalog runtime dependencies such as FFmpeg, Chromium and pandoc can also be installed separately. Installing does not grant or publish anything unless you select those optional choices in the last wizard step.

The gallery loads a fresh signed directory when opened or when checking updates;
it is not bundled or cached. The default address is
`https://github.com/dake6767/dsh-phalanx-catalog/releases/latest/download/catalog.json`,
accessed through the configured **GitHub asset prefix** in **Download sources**.
To use another service or mirror, set `DSH_PHALANX_SUITE_CATALOG_ADDRESS` in the
[protected service environment](install.md#service-management-and-recovery),
then restart the platform. Supply an HTTP(S) document URL without credentials,
a query or a fragment. A custom URL is used as given, without adding the prefix;
changing the address does not change the trusted signing keys.

**The catalog service is unreachable** shows the address and transport reason when the
service cannot be reached. An invalid signature, unknown signing key or invalid
document rejects the whole directory and displays its rejection reason.
Incompatible entries remain visible as **Needs a newer platform version**, with installation
disabled. Each suite also shows its declared external service addresses.
Offline deployments cannot browse the gallery. Installed entries and prepared
dependencies remain usable, and uninstalling or detaching them uses local records.

Choose **Install**, review the pinned sources, identity, created entries and any manual replacements, then confirm. Preparation follows **Download sources** for npm, PyPI, container images, GitHub assets and browsers; explicit preparation URLs take precedence. The **Mainland China** preset applies to supported downloads. Catalog definitions pin versions and verify downloaded release assets. Prepared dependencies are reused without installation inside member instances. Network downloads are still needed when the required inputs are not already available.

Installation runs as a background task with progress and logs. Dependencies and skills are prepared before library entries are written. Failure rolls back the task and keeps its logs; retry from the catalog. Team credential fields may be skipped: the suite then shows **Missing credentials**, and delegated execution stays off until the administrator fills them in through the suite details. Saved platform credentials never enter member spaces. Members' personal CLI logins remain in their own home; the deployer can read that data root.

### Updates, detaching and uninstalling

A platform upgrade does not update installed catalog entries. **Update available** appears when the online catalog has a newer version. Choose **Update** to preview dependency changes, skills added/updated/removed, skill-pack membership, delegated commands and credential variables. A shared dependency's preview also names the suites using it. New dependencies are prepared and checked before switching; the most recent successful old dependency version is retained. Saved credentials, grants, publication and member selections are preserved for surviving entries. Added skills join the suite pack and follow its grants; removed skills are withdrawn. A newly required credential keeps execution off until saved. A failed update restores the previous version. If recovery or final cleanup cannot finish, the log records the pending step; restart the platform to retry it before another suite task.

Suite-owned library entries are read-only and show their source. **Detach from suite** makes an entry an ordinary editable entry, preserving its grants, publication and references. It stops following suite updates and stays when the suite is uninstalled. Detaching a skill also detaches its delegated execution configuration.

The uninstall preview lists entries, affected groups, publication and member selections. Confirmation removes their suite grants and publication too. Shared dependencies remain while another suite or library entry references them; when unused, their removal is offered and selected by default. Detached entries remain. A manual skill or other external reference to a suite's private dependency blocks removal: detach the dependency or change the reference first. Already-running processes are allowed to finish with their retained versions.

### Existing manual entries

If a manually prepared dependency already supplies all commands of a shared catalog dependency, the suite reuses it and shows **Your manual dependency my-ffmpeg is used; its version is not pinned**. Suite updates leave it alone. Its runtime-dependency details offer **Switch to the catalog version**, which opens a confirmed replacement task and preserves the library name and references.

A suite's own CLI and same-name skills from the same Git repository may replace manual entries once. Review the replacement list and select its confirmation checkbox before installing. Library names remain stable, preserving references, grants, publication and member selections; saved credentials carry over. Failure restores the manual entries. A same-name skill from a different repository, a conflicting MCP-owned dependency or a same-name manual skill pack blocks installation; resolve that conflict first.

### OfficeCLI: member-side file editing

Install **OfficeCLI** from the suite catalog, then grant its skill pack or publish it for members to select. No credential or platform execution is needed. The CLI runs in each member's workspace and creates or edits their `.docx`, `.xlsx` and `.pptx` files. The supplied wrapper disables automatic updates. When a script must immediately inspect a saved file, use `OFFICECLI_NO_AUTO_RESIDENT=1` or `officecli close <file>` as described in the skill.

### MiniMax: delegated generation

Install **MiniMax** and enter the team's `MINIMAX_API_KEY`, either in the wizard or later in suite details. The suite prepares its CLI, imports the skills, and configures delegated execution. The key stays platform-side; generation uses the team's quota and saves results in the invoking member's workspace. The supplied wrapper fixes the China region and blocks credential/configuration commands and endpoint overrides. Grant or publish its skill pack and verify a generation task in a new member session.

### Feishu: delegated bot identity

Install **Feishu** and enter `LARKSUITE_CLI_APP_ID` and `LARKSUITE_CLI_APP_SECRET`. Its skills use platform execution as the team's Feishu app bot; members do not sign in for this identity. The wrapper obtains a tenant token without saving a credential file and blocks identity/configuration changes. Personal member identity (`--as user`) is not provided. Grant or publish its skill pack, then verify a bot operation permitted by the app's Feishu scopes in a new member session.

### WeCom: member-owned login

Install **WeCom** and grant or publish its skill pack. There is no team credential and no delegated execution. Each member runs `wecom-cli auth init` in their own terminal, scans the QR code with WeCom, then checks `wecom-cli auth show --status`. Personal authentication remains in that member's home and is not shared with other members. Updating the CLI does not sign anyone else in.

### HyperFrames: local rendering

Install **HyperFrames** to prepare the CLI, shared Chromium headless shell and FFmpeg, and its local rendering skills. Grant or publish its skill pack and ask a member's agent in a new session to render a short MP4 in their workspace. No platform credential is required. The wrapper selects the catalog browser and disables telemetry. The suite supplies local rendering; offline ML engines and HeyGen voice, music, avatars and cloud services are outside its supplied configuration. A member can separately manage their own upstream login.

The official online definitions provide Linux amd64 and arm64 preparation for these suites and shared dependencies. The catalog evaluates the actual host architecture; an entry without a matching definition shows **Unavailable on this architecture** and cannot be installed. This availability is not a claim that every architecture has completed release acceptance.

<a id="cli-configuration-examples"></a>

## Appendix: manual setup without suites

For manual setup, create the named **Runtime dependency**, enter its preparation/PATH/check settings and wait for **Ready**. Import and review the upstream skills, attach the dependency, and organize a skill pack before granting or publishing it. In the orchestration note, say that the platform supplies the CLI and members must not run installation/update instructions. For delegated tools, configure the listed commands, blocked first arguments and secret variables. Preparation never receives credentials; keep keys out of preparation commands. These pinned examples target Linux amd64; review their sources before use. npm examples explicitly use `https://registry.npmmirror.com`.

### OfficeCLI: member-side file editing (manual)

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

### MiniMax: delegated generation (manual)

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

### Feishu: delegated bot identity (catalog entry)

Install the **Feishu** suite from the signed catalog and enter `LARKSUITE_CLI_APP_ID` and `LARKSUITE_CLI_APP_SECRET`. Its skills use platform execution as the team's Feishu app bot; members do not sign in for this identity. The platform-generated token adapter requests a fresh tenant access token from the Feishu endpoint declared by the entry with redirects disabled, so the app secret cannot be re-posted to another host; it sets `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` only in the child process environment, writes no credential file, and fixes the Feishu brand and bot identity. Do not hand-write this wrapper: the signed catalog adapter is the supported path and keeps the redirect protection. Grant or publish its skill pack, then test with `lark-cli api GET /open-apis/bot/v3/info --as bot` in a new member session. A member's home configuration cannot replace this platform identity; the invocation uses a fresh temporary HOME.

### WeCom: member-owned login (manual)

Use dependency `wecom-tools`, PATH directory `node_modules/.bin`, check `wecom-cli --version`. Do not enable platform execution or configure platform credentials. Keep `wecom-cli auth init` in the skill instructions. The member runs it in their terminal and completes the QR authorization, then checks `wecom-cli auth show --status`. Personal authentication data remains in that member's home. Granting or updating the shared CLI does not grant a personal login to other members.

```sh
set -eu
npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com @wecom/cli@1.3.4
```

### Python CLI preparation with venv

For a reviewed Python CLI, use the image's Python to create a virtual environment inside the fixed preparation path. Replace `<reviewed-package>`, `<version>` and `<command>` with the reviewed package, pinned version and its executable. Set the dependency PATH directory to `.venv/bin` and its check command to `<command> --version`. This installs a CLI environment; it does not install or upgrade Python. Choose a package compatible with the Python supplied by the instance image.

```sh
set -eu
python3 -m venv --copies "$RD_OUT/.venv"
"$RD_OUT/.venv/bin/python" -m pip install \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  '<reviewed-package>==<version>'
```
