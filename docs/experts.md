# Experts

[简体中文](experts.zh-CN.md) · [Installation](install.md)

An expert combines a persona, an optional shared model and entries from the plugin,
skill, skill pack and MCP libraries into a DSH working mode. Each expert includes
the standard file, terminal, search and subagent tools. Members' existing global
capabilities remain available in expert mode.

## Assemble and distribute an expert

1. Prepare the required entries in their libraries, including platform upstreams,
   execution credentials and MCP configuration. Credentials stay on the platform.
2. Open **Expert library → Create expert**. Enter a name, description, icon and
   persona; choose library entries and optionally an enabled shared model and
   two or three example tasks. The persona supplements the standard instructions.
3. Save. A new expert is neither published nor granted to ordinary groups.
4. Grant it under **Group management → Details → Expert grants**, or publish it from the
   expert library so members can summon it in **Platform App Center → Experts**.
   Administrator groups automatically own every expert.

Plugins that change existing DSH core entries cannot be included. An expert
references current library entries rather than copying their contents. A library
update therefore affects the expert when the member next restarts their instance.

**Summoning lets members use every included entry with its configured platform
credentials throughout their instance, including entries not granted separately.**
The credential values stay on the platform.
Publishing an expert makes that access available to all members who summon it.
The extra entries appear in expert mode, but gateways authorize the member rather
than the active conversation. Experts do not restrict members' global abilities.

## Summon and start work

Open **Platform App Center → Experts**, review the included entries and click
**Summon expert**. Restart your DSH instance using the displayed link. Group-granted
experts show as owned and cannot be dismissed by the member.

Click **Start conversation** to create a new conversation in that expert mode and
preselect its enabled shared model. You can change the model in the native model
picker. If the chosen shared model becomes unavailable, new conversations use the
host default; the administrator sees a warning in the expert library.

You can also choose the expert from the native DSH mode list. That entry follows
the host's model rules: it does not preselect the expert's model. Use **Start
conversation** in the App Center when you want that model selection.

Your globally installed plugins, skills and MCP services remain usable. Entries
already supplied globally are not loaded again inside the expert. A native copy
of the same plugin follows the existing platform/native plugin coexistence rules.

## Edit, repair and remove

Expert changes apply after members restart their instances. Until then, active
conversations retain their previous definitions. After restart, both restored and
new conversations use the current definition; old revisions are not restored.

If a referenced entry is removed, unavailable or incompatible, the expert skips
it and keeps its remaining capabilities. A plugin or MCP startup failure is
isolated from healthy expert entries. The library identifies unavailable entries
or affected instances; member cards show partial availability. Edit the expert to
remove an unavailable saved reference or repair its library entry, then restart.
An unavailable shared model has its own warning and default-model behavior.

**Dismiss expert** immediately withdraws access supplied only by that expert.
Unpublishing, removing a group grant or deleting the expert has the same access
rule. Independent group grants, market selections and other owned experts still
provide their own access. Already loaded definitions disappear on restart.

After losing the expert and restarting, its old conversations cannot continue.
History remains available for viewing. Summoning the same expert again and
restarting restores the ability to continue those conversations with its current
definition. Resetting the DSH environment preserves expert definitions and summons.

Before deletion, the administrator sees the current members and groups that hold
the expert. Confirming deletion clears its grants and summons. If that impact
changes, review the preview again. Recreating an expert makes a new identity and
does not restore conversations belonging to the deleted expert.
