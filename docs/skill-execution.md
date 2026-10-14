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
