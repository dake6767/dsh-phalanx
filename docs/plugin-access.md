# Plugin access

[简体中文](plugin-access.zh-CN.md)

Platform apps are plugins checked in the administrator's library and offered to members.
Group grants provide **platform preinstallation**; optional member selections come from
the **platform app center**. Both load read-only at the administrator's selected version.

A plugin upstream holds a service address, request headers and a platform credential.
Access settings supply environment variables and configuration merged by entry ID.
Authorized members can use the platform credential without reading its value from their spaces.

## Setup

1. Add an exact version or upload a `.tgz` in Plugin library, then wait for checks to pass.
2. Open Access settings in the plugin details and add an upstream. HTTP(S) and private network addresses are supported. Its name is local to this plugin.
3. Enter the real key in Platform credential. Reference it in headers with `{credential}`, for example `Authorization: Bearer {credential}` or `X-API-Key: {credential}`. Fixed headers replace member-supplied values and can lock a tenant ID.
4. Save a test request and choose **Test saved request**. This checks the address, credential and headers; complete the access settings and call the actual plugin to verify the full path.
5. Use `{upstream:name}` for the forwarding address and `{access-token}` for the member token in environment variables or entry configuration. Never put the real key here. Variables apply to the entire instance and override existing variables with the same name. Each variable name can belong to only one platform app; platform runtime variables are reserved.
6. Write YAML using the entry IDs listed in the interface. Objects merge recursively; arrays and scalars replace existing values. YAML tags and expressions are unsupported. Affected members must restart their instances after saving access settings.
7. Grant platform preinstallation to a group or publish for all members to select. Publishing an app with credentials requires confirmation that all members will be allowed to use them.

Upstream address, header and credential changes apply to the next request without a
member restart. An upstream still referenced by access settings cannot be deleted;
the interface identifies its references.

## Lifecycle

Version changes preserve upstreams and access settings. Missing entry IDs are marked
invalid and skipped; other entry settings and environment variables still apply.

Unpublishing clears member selections and retains group grants. Removing a plugin
clears its upstreams, credentials, access settings, grants and selections while keeping
native member copies. Loading changes after restart. When revocation or unpublishing
removes all authorization, the next upstream call is immediately rejected. Disabling
the account also rejects subsequent calls.

System upgrades and member environment resets preserve platform access data and selections.
Reset clears native member-installed plugins; the replacement instance loads apps from
retained platform settings. See [Groups and plugins](install.md#groups-and-plugins).

## Boundaries

The plugin must support configurable service addresses through environment variables or
configuration, and send its key in request headers. Forwarding is generic, without
plugin-specific adapters.

The platform does not enforce outbound routing, lock member settings, manage self-installed
plugins, rewrite response URLs or provide usage tracking and quotas. Members can change
their own access settings. Direct third-party calls require their own keys. Authorized
members can call platform upstreams with member tokens; permission to use a credential
does not grant permission to read its value.
