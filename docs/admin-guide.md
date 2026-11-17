# Administrator guide

[简体中文](admin-guide.zh-CN.md) · [Installation](install.md) · [Operations](operations.md) · [Member guide](member-guide.md)

Use the administration console to manage accounts, groups and platform capabilities. See [Operations](operations.md) for deployment, upgrades and backups.

## Shared models

Open Model management at `/admin/models`, choose the provider protocol, add individual model rows and save the provider explicitly. The base URL keeps the prefix that protocol expects. For Anthropic Messages, DeepSeek uses `https://api.deepseek.com/anthropic` and Volcengine Coding Plan uses `https://ark.cn-beijing.volces.com/api/coding`; the gateway appends `/v1/messages`. For OpenAI Chat Completions or OpenAI Responses, keep any version prefix the provider requires, such as `https://api.deepseek.com/v1`; the gateway appends `/chat/completions` or `/responses`. Choose a replacement default before disabling or deleting its current model or provider. Existing member catalogs update without a platform restart.

Each model row has a **Supports images** switch. Known vision models such as
`deepseek-flash` start with it enabled; other model identifiers default to text
only. Save the provider after changing it. The declaration governs image uploads,
`read_image` and subagent image input through DSH. Disabling it makes DSH reject
images before model admission. New rows use the same known-model defaults; saved declarations remain
unchanged. This switch declares upstream capability; it cannot add image support
to an upstream model that lacks it.

**Supports reasoning effort** is off by default for every model, including existing
models. Enable it only when the upstream supports selecting reasoning intensity.
This declaration exposes Off, Low, Medium and High in DSH's conversation model
picker; disabling it hides the Effort control. It does not turn the model's own
reasoning on or off. The member or provider chooses the default. The platform
passes reasoning fields through without choosing a default effort.

## Platform web search and voice input

Open **System settings → DSH features**. In **Platform web search**, enable search, enter the dedicated **DeepSeek Search API key** and save. A shared model provider key does not configure search. Leaving the field empty when a search key is already saved keeps it. Turning off search retains the key. **Clear search key** removes it and turns off access. Members receive the setting at the next instance start. Platform search supplies the search tool. The platform does not offer page fetching through the built-in fetch tool.

In **Platform voice input**, select **Standard (INT8)** or **High precision (FP32)** and enable voice input. FP32 requires a larger download and more memory in each member instance. Wait for **Voice input ready**. If the download, verification or storage fails, check the reported cause and choose **Retry preparation**. An active model remains available while another precision is being prepared. Members receive the setting at the next instance start. To use a microphone remotely, open the platform over HTTPS and grant browser microphone permission. Localhost can also use the microphone.

## Platform credentials and member credentials

Enter provider and plugin service keys in their administrator settings. PostgreSQL stores these platform credentials encrypted. In place of a saved plugin upstream key, management responses expose the configured state and the last four characters. Other secret fields may show only a configured state. See [key backup and recovery](operations.md#master-key-backup) for the matching key and database.

Adapted native plugins receive a scoped platform service token. The platform gateway checks its scope and authorization, then attaches the real upstream credential to the provider request. A plugin setting named `apiKey` may hold the platform token. Members with access to their own plugin settings can read that token. Manage the grant and the upstream in [Plugin and MCP access](plugin-access.md). Personal keys that members enter into plugins belong to the plugin's storage. The platform does not automatically encrypt them in its PostgreSQL database.

## Member instances

In **System settings → Member instances**, set the default **CPU (cores)**, **Memory (MiB)** and **Processes** for each member container. Enter positive values; CPU can be fractional and the process count must be an integer. Leave a field blank for unlimited. New installations start with unlimited defaults. **Use suggested limits** fills in a starting point: half the host memory capped at 4 GiB, half the CPUs with at least one core, and 2048 processes. Review and save these values for your workload; suggestions are not applied automatically.

In an account's **Instance resource limits**, choose **Inherit defaults** or **Custom limits**. Custom limits replace all three default fields, including any left unlimited. Save to change the target limits; a running instance keeps its current limits until its next start or explicit application. Compare **Target limits**, **Current limits** and **Limits pending** before applying.

Use **Apply to running instances** in system settings or **Apply immediately** in account details, then confirm the affected instances. The platform updates live limits when supported and restarts an instance when live application is unavailable, interrupting its tasks. Lowering memory can terminate running processes; a finite memory limit disables swap. Review individual results after a partial failure. Capacity guidance adds target memory for running or enabled resident members, counting each once and listing unlimited targets separately. It warns about overcommit without reserving memory or blocking startup.

Resource settings are stored in the platform database. `DSH_PHALANX_CONTAINER_ARGS_JSON` is no longer accepted; remove it and use administration to configure member limits.

In **System settings → Member instances**, set idle reclamation in seconds (default 1800; 0 disables it). The deployment idle setting is imported once; later changes belong in the system settings. Development mode uses the same idle and resident behavior; container resource limits still require container mode.

In an account's details, select **Resident instance** and save. Enabled resident members start automatically after platform startup or upgrade, with at most two automatic starts at once. Entering a queued member's workspace moves it ahead in the queue. Resident instances skip idle reclamation and restart after a confirmed unexpected exit. An automatic startup failure is shown with its time; the platform does not keep retrying it. Enter the member workspace to try again.

Disabling an account stops its instance and keeps the resident setting; enabling it resumes automatic startup. Deleting the account removes that setting. Resident counts have no fixed limit. Capacity guidance counts running or resident members once and only warns about memory overcommit. **Restarting the platform interrupts tasks in resident instances.**

In Account management, the member row's **More actions** menu starts with **Switch to this member’s DSH**. It fixes the target username and requires that account's password. Errors leave the administrator signed in; Cancel returns to account management. Success opens the target DSH, including administrator targets, and preserves the original administrator in the browser's remembered accounts. A full ten-account list refuses the switch without displacing an account.

The same menu offers **Start instance** for a stopped member or **Restart instance** for a running member, immediately above environment reset. Restart requires confirmation that tasks will be interrupted and retains configuration, plugins and persistent files. Disabled accounts and instances with an operation in progress cannot be started or restarted. Refresh the page if another operator changes the state.

## Groups and plugins

Use **Skills → Skill catalog** and **Plugins → Plugin catalog** for reviewed entries and their dependencies. See [Skill catalog](skill-execution.md#skill-catalog) and [Plugin catalog](plugin-access.md#plugin-catalog).

Each account belongs to one group. New ordinary accounts enter the default group;
existing ordinary accounts join it during migration. Administrators belong to a
protected group with explicit plugin, skill, MCP configuration, like ordinary groups. Library management permissions come from the account role and do not depend on these grants. Assigning or revoking
an administrator role changes group membership in the same operation. Change the
default group in Group management; groups with members and the default group cannot
be deleted. Manage member membership and filter by group in Account management.

In **Plugin library → Add plugin**, enter a package name, `package@1.2.3` or
`package@latest`; scoped names such as `@scope/package` work too. A name without
a version uses `latest`. Precheck resolves it to an exact version and displays the
package name, source and checked content. Choose **Confirm and add** to put that
checked version in the library; a later change to `latest` does not change it.
Version ranges and other tags are not supported. You can also upload
a private `.tgz` archive through the separate upload action.

To add a plugin from a public GitHub repository, enter `github:owner/repo` or
`https://github.com/owner/repo`. Precheck pins the default branch to its latest
commit, downloads that commit's source and packs it in a network-disabled container
without running any repository script, including `prepare` and `prepack`. The packed
archive then goes through the same checks as an upload. The preview shows the
package name and version from the repository's `package.json` and the pinned commit;
the library shows the version as `x.y.z (abc1234)`. The repository must contain the
built files its `main`, `exports` and `dsh.bundle` entries name, because the platform
does not build plugins: a repository without them fails with a build-required error,
so use its npm package or upload a `.tgz` instead. Dependencies must come from the npm
registry, including `npm:` aliases; Git, URL and path dependencies are rejected.
Clone-style Git URLs (`git+...`, `ssh:`, `git@` and `.git` archive URLs), branches, tags, commits and other Git hosts are not supported. The platform checks
the package and its dependencies in a disposable container, then checks activation
offline. Adding a plugin neither grants it to any group nor publishes it.
Configure optional upstreams, platform credentials and access settings in the
plugin details. See [Plugin and MCP access](plugin-access.md) for setup and boundaries.

The library records where each plugin came from. A package name has one source:
npm, upload or one GitHub repository. Adding or replacing it from another source is
rejected; remove it first, then add it again from the other source. Choose **Check
for updates** in a plugin's details to compare, on demand, the library version with
npm `latest`, or the recorded commit with the GitHub default-branch head; a new
commit is reported even when the package version number did not change. The
platform never checks or updates on its own. **Precheck update** resolves the new
npm version, or packs the new commit's source through the same GitHub precheck, and
checks it as a replacement candidate; the current version stays active until you
select the candidate. Uploaded plugins are updated by uploading a replacement
archive.

The **Plugins** tab in group details has two lists:

- **Platform controlled** loads the selected library version read-only. Members cannot
  change its settings, disable it or uninstall it through plugin management. Without
  platform credentials, some plugins may have limited functionality. Grant changes
  take effect after restart; pending counts and the confirmed **Restart affected members**
  action identify running members whose configuration differs.
- **Preinstalled plugins** installs a native copy once, in the background after the instance is
  ready. Members can change settings, disable, upgrade or uninstall that copy. Removing
  it from the list, changing groups or uninstalling it does not install it again.
  Failed deliveries retry on the next instance start; the tab shows only the count
  of members with incomplete deliveries. Changing groups installs only packages
  that member has not received before. A package cannot be in both lists for one group.

Members can install their own plugins and use terminals according to the group’s feature settings. A native copy yields to existing selected read-only access;
preinstallation still installs it once and records success. The read-only copy takes
priority until that eligibility ends and the instance restarts. Explicitly disabled
member bundles remain disabled. Adapted entries can deliver scoped platform service settings to eligible native copies. The real upstream key stays on the platform.

Publish a checked plugin to offer it in **Platform App Center**. Ordinary plugins install as member-managed native copies. Shared-credential selections load read-only unless the catalog entry declares a supported native service binding. Independently installed same-name plugins stay in the native plugin manager. See [the member guide](member-guide.md#enter-dsh-and-use-platform-app-center) for member actions and [native service settings](plugin-access.md#platform-service-settings-for-native-plugins) for the adapted path.

Unpublishing hides the listing and clears read-only member selections; group control
remains. Installed native copies, their settings and delivery history remain, including
after restart. **Unpublishing is not a fleet uninstall; use Platform controlled when
access must be revocable.** Losing all authorization rejects the next platform upstream
call immediately; disabling an account also rejects subsequent calls.

A replacement version is checked while the current version remains selected.
Selecting the replacement shows affected group and member counts and requires
confirmation. It updates read-only loading, not versions already installed in member
profiles. Members manage native versions themselves. Upstreams and access settings survive version changes; missing entry IDs
are marked and skipped while other entries and environment variables still apply.
Removing a library plugin clears its grants, publication, selections, upstreams,
credentials and access settings; native member copies remain. After a system update, current and candidate plugins
are checked against the selected runtime before service readiness. This can extend
startup. Incompatible plugins retain grants but stop platform loading and disappear
from the marketplace. Selecting a compatible replacement restores loading and the
previous publication intent; administrators can cancel automatic republication.
If a plugin is marked incompatible, obtain a release that supports the selected DSH
runtime and check it as a replacement. The platform retains the original package
and authorization records; it does not rewrite third-party plugins or restore removed
runtime services. Native self-installed copies must be handled on the native plugin page.

System upgrades preserve platform data. Resetting a member's DSH environment clears
native plugins and platform-owned yield entries from that profile. Successful preinstall
delivery records are cleared, so the replacement instance installs once from the current
group list. Self-selected native plugins are not restored automatically. Library data,
group lists, read-only selections, upstreams, credentials and access settings remain.
Administrator and member resets follow the same rules. Back up platform plugin state
together with the account database and member storage.

### Configure features by group

In **Group management**, open a group and choose **Feature settings**. Save changes for that group.

- **Show Platform App Center** controls the sidebar entry on the next DSH page refresh. Existing library resources stay available.
- **Manual terminal access** controls the sidebar and manual terminals. Agent commands and delegated platform execution remain available.
- **Add plugins** controls installing from the native plugin page and first enabling optional bundles. Members can install published entries when Platform App Center is visible.
- **DSH built-in Agent presets** controls preset availability for new sessions. After restart, sessions using a disabled preset can resume once it is enabled again. Keep at least one preset enabled.

Restart running instances to apply changes to native terminal, plugin or preset settings.

## Skill, plugin and MCP catalogs

Open the catalog tab in the corresponding library. The skill, plugin and MCP catalogs use the same signed catalog source. Search within the open catalog by name, description or entry ID. Where entries have tags, choose one in **Filter by tag** to narrow the search. **All entries** includes unclassified entries, and **Unclassified** shows just those entries. **Clear filters** resets the search and tag selection. The tag selector appears when the catalog has tagged entries.

MCP catalog imports and updates use a verified target. The details show the remote service or shared runner and any credential you need to supply. If a target is unavailable, use **Reload the MCP catalog** to check again. Installed MCP services keep their settings, credentials and access. You can still manage and test them from **MCP services** in the MCP library. Updates require administrator confirmation.

## Platform app center and MCP

In administration, plugin, skill, skill-pack and MCP details begin with a **Platform
App Center** section. It shows publication separately from availability and provides
independent publish/unpublish actions with an impact confirmation. Save a new resource
first; save or discard pending edits before changing publication. Catalog content stays
read-only while its publication remains an administrator choice. Updates preserve that
choice. A plugin paused for incompatibility explains automatic republication and lets
you cancel it. Published empty or conflicting packs show why members cannot use them.
When platform credentials are involved, confirmation explains that all members may use
them through the resource. Unpublishing retains group grants; republishing does not
restore cleared self-selections. Native plugin copies remain installed, while shared-key
plugin selections stop loading after restart. Skill, pack and MCP selections are cleared
for the resource being unpublished.

Open **Platform apps** from the DSH sidebar. Its tabs are **Plugins | Skills | MCP services**, in that order. The account menu and recovery page also link
to this entry. The standalone `/market` page is unavailable; replace old bookmarks
with the DSH sidebar entry. This does not remove the native DSH plugin manager.

The **Skills** tab includes expandable skill packs alongside individual skills. Native plugin operations report whether they apply immediately or
require a restart; the platform never restarts automatically. Read-only plugin changes
require an instance restart; skill and pack changes
apply to new sessions; MCP changes refresh tools on the next agent request without a
restart. A failed tab can be retried without blocking the others.

Administrators configure MCP services, preparation, credential templates and tool
restrictions in **MCP library**, then grant services through Group management or
publish them for member selection. Follow [MCP services](plugin-access.md#mcp-services)
for run-location choices, testing, authentication limits and lifecycle behavior.
Back up MCP state with the platform PostgreSQL database. Changing the supported DSH revision
regenerates member MCP configuration and prepares command dependencies for that
runtime before those commands become available.

## Skills

In **Skill library**, upload one ZIP archive containing one or more skills, or enter a public Git source.
Review the discovered skills, their file trees and rendered `SKILL.md`, choose what
to import, and explicitly confirm same-name replacements. Administrators review
package behavior. The platform rejects unsafe archive paths, links and special
files, and warns about common secret filenames/content patterns without showing
matched values. These checks do not certify code or detect every secret.

Manual uploads and ordinary Git imports limit each skill to 20 MiB and a
multi-skill intake to 100 MiB.
Skills installed or updated from the signed catalog have separate limits:
16384 files and 128 MiB for the repository, with at most 64 MiB per skill.
A catalog entry that exceeds these limits shows a specific catalog limit error.
Path and link checks apply to both profiles; catalog provenance does not grant
larger limits to a later ordinary Git import.
A root `SKILL.md` selects one skill. Otherwise discovery searches supported skill
containers, then bounded nested directories. Frontmatter `name` uses lowercase
letters, digits and single hyphens; it identifies the skill independently of ZIP
filenames or `_meta.json`. Description is required. Runtime reserved names are
rejected. Internal skills start hidden. No dependency or script runs during import.
Configure optional [platform execution](skill-execution.md) separately.

Each discovered skill is validated independently. A skill whose `SKILL.md`
frontmatter is invalid appears under **Unable to import** with its file path, the
failing field and the reason; valid siblings remain importable in the same preview,
and a description that needs quoting for a colon is reported as such. Source-level
problems such as unsafe paths, links or special files still reject the whole
source, and a source with no valid skill keeps the original no-skills error.

### Skill packs and multi-skill imports

The **Skill packs** tab combines existing library skills with a name, description
and optional orchestration instructions. Packs do not nest or duplicate skill
files. Group grants and published member selections work for whole packs; effective
access is the union of direct and pack access, with managed access taking priority.
An orchestration skill appears only while the pack has an available child.

New packs start unpublished. Saving content preserves publication; use the independent
action in the detail's **Platform App Center** section to publish or unpublish. Empty
packs can remain published while unavailable to members; no new publication prerequisite
is imposed. Unpublishing a pack clears that pack's selections and retains its group
grants and individual skill selections.

The skill library, group grants and member skill choices show packs
as expandable entries. Packed skills remain inside their packs unless a direct
group grant or member selection also keeps them at the top level. If a member
cannot see any parent pack, an otherwise visible skill retains its individual
entry. Hidden packs and their other children are not disclosed. Expanding a visible
pack shows its children; individual installation and full skill details retain
their existing publication and direct-grant requirements. Selecting or granting a
whole pack still makes all its available children usable. Existing group
choices are preserved.

Multi-skill import lets you select an orchestration document; a document declaring
`orchestration.children` is preselected. Confirm the suggested pack name and selected
children before importing. Recognized plugin manifests can suggest packs; remaining
skills appear under **Other skills**. Cancelling the preview changes nothing.

Removing a pack normally preserves its skills. The optional delete-skills action
previews which children can be deleted: another pack or an explicit group grant
keeps a child. Direct member selections of deleted children are cleared. Removing
a child from the library also removes its pack references; an empty pack stays in
administration and disappears from member applications. Environment reset retains
pack selections. Account deletion clears that account's selections.

### Git sources and updates

Acceptable sources include `owner/repository`, a GitHub tree URL, and a public
HTTPS Git URL, optionally with a subpath and `#ref`. Private repositories, SSH,
local paths, registry APIs and embedded credentials are unsupported. Imports do not
use the administrator's Git credentials, hooks, global configuration or submodules.

The details page records the source URL, path, ref, commit and content identity.
**Check for updates** creates a review of changed, new, unchanged and removed skills.
Choose replacements and removals explicitly. Cancelling preserves the current
library; no periodic or automatic update runs. A ref change may resolve to a new
commit while unchanged skill content remains unchanged.

Git uses the [deployer egress proxy](operations.md#egress-proxy). A custom trusted CA can be supplied with `GIT_SSL_CAINFO`. The installer supplies Git and upgrade preparation installs it when missing.

Administrator and ordinary groups start with no skill grants: select **Group management → group details → Skills** to grant
skills. Importing does not grant any group access or publish the skill.
Publish it from the skill details to offer it to everyone in **Platform apps → Skills**.
Members install and uninstall their own selections there. Group-granted skills show
as platform preinstalled and cannot be uninstalled by members. Unpublishing clears
member selections while retaining group grants; republishing does not restore selections.
Removing a skill clears both grants and selections.

Platform skill files are read-only in member containers. Changes apply to new DSH
sessions without restarting the instance. Replacement, revocation, unpublication
or removal can make a running task fail; confirmation dialogs show affected member
counts. Previous versions are not retained. If synchronization fails, the management
page reports it and provides **Retry skill synchronization**. Retry reapplies the
saved desired state.

Members may keep their own skills under `~/.dsh/skills` or `~/.agents/skills`.
Their same-name skill takes precedence over the platform copy; Platform apps shows
an override notice when a same-name top-level directory is present. The platform
neither edits nor removes those files. This differs from managed plugins, where
the platform copy takes precedence. Revoking a platform skill cannot revoke a
member's own copy. Resetting the DSH environment preserves managed, selected and
member-owned skills; skills are outside that reset backup. Disabling an account
stops distribution; deleting it removes its platform skill projection and selections.
If a runtime update introduces a bundled skill with the same name, the library
retains the package, displays the conflict and stops distributing it.

### Administrator environment recovery

In account management, choose **Reset DSH environment** for the enabled member and confirm that running tasks will be interrupted. This works even when the member cannot open DSH. The platform stops that member's instance, completes a private backup, resets the web profile (including installed user plugins), home patch/environment and pending legacy Settings import, then starts a replacement. The member's space URL, projects, chats and other personal files are preserved. A member with no instance can be started through this action.

Container instances provide a private system credential service for native plugins. A normal restart preserves credentials saved through that service. Resetting the DSH environment includes that credential store in the private web profile backup and starts with a fresh store.

Backup failure leaves the original configuration intact. Reset or startup failure reports the completed backup and restore instructions; it does not report success. Backups are retained under `<userDataRoot>/_environment-backups/<spaceId>/<backupId>` on the user-space volume, outside member container mounts. They may contain private settings and credentials. The result points the deployer to a `README.txt` and manifest describing present and absent configuration carriers. The manifest identifies the home relative to the user root; after a volume move, resolve the recovery instructions against the current configured user root. For manual restoration, stop the platform service **and verify the target container is removed**, preserve the current carriers separately, then restore only the listed originals without following symlinks. Platform shutdown alone can leave containers running. Restoring an old backup also restores its old fault. After a new complete backup is published, the platform keeps the latest three complete backups per member across administrator and member requests. Only verified backups in that platform space are eligible; unknown, linked or incomplete directories remain. Cleanup failures are logged without blocking the reset. Account details show the time and initiator of the latest reset request.
