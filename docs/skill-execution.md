# Configure platform execution for a skill

[简体中文](skill-execution.zh-CN.md) · [Skill library](install.md#skills)

Platform execution lets an authorized member invoke an administrator-configured command with platform credentials. Credentials remain in platform storage and enter only the preparation or execution process. Ordinary skill scripts still run with member permissions unless explicitly delegated.

## Review and configure

Import and review the skill, open its details, then choose **Platform execution**. The scan offers command, variable and preparation suggestions; it does not execute them, prove their safety or save them automatically. Confirm each field and enable execution explicitly.

A command is an executable name on the prepared PATH, such as `tencent-news-cli`, or a script path relative to the skill, such as `scripts/mps_usage.py`. Use `./query.sh` for a root-level script. Multiple command rows may have separate blocked first arguments. Members invoke the normal command or original script path; platform forwarding preserves arguments, binary stdin, stdout, stderr and the command's exit status.

Variables have independent names, values and **Secret** switches. Secret values are write-only: after saving, the page shows whether a value is configured. Leaving an existing secret value blank retains it; remove its row to remove it. Plain variables remain visible. Changing a secret variable to plain text requires entering a new value. Reserved process variables are rejected.

## Tencent News example

Review the upstream archive and CLI installer first. Configure command `tencent-news-cli`, secret variable `TENCENT_NEWS_APIKEY`, and blocked first arguments `apikey-get`, `apikey-set`, `apikey-clear`, `update`.

A preparation command can install the CLI inside the private prepared tree:

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

Preparation runs in a separate network-enabled container with the skill's configured variables and no member files. Its PATH includes `.venv/bin`, `node_modules/.bin` and `bin` within the prepared tree. For a Python skill, an administrator can use:

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
```

Configure multiple variables independently, for example `TENCENTCLOUD_SECRET_ID` and `TENCENTCLOUD_SECRET_KEY`, plus plain region or bucket settings when required. Preparation logs are bounded and exact configured secret values are redacted. Prepared content is hashed and frozen read-only.

Skill, preparation-command, variable or runtime-image changes trigger preparation again; **Prepare again** retries manually. A previous usable artifact remains available while its replacement is preparing. A failed preparation blocks execution until a successful retry. Updating a skill retains its execution settings and marks missing script paths unavailable. Removing the skill clears its configuration, credentials and prepared state; artifacts still used by an invocation remain until that invocation finishes.

## Access, limits and records

Administrators receive available library skills. Other members qualify through direct group grants, granted packs, published skill selections or published pack selections. A same-name personal skill does not remove their platform execution eligibility. Every invocation rechecks current account and skill access; disabling an account or removing all access denies the next call.

Each installed-mode invocation runs in a fresh rootless container with the caller's home/workspace, read-only prepared dependencies, and only the configured variables. Member environment variables are not forwarded. The current directory must belong to that member's space, so relative output files belong to the caller. Commands can access the network.

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
