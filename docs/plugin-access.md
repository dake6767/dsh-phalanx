# Plugin and MCP access

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

## Connection examples

These configurations were exercised with both group grants and member selections.
AnySearch used its real upstream; the other examples used controlled protocol fixtures.
Replace the `.example.invalid` addresses, model, tenant and knowledge-base identifiers
with your service values. Enter each real key only in that upstream's **Platform
credential** field. Keep `{credential}`, `{access-token}` and `{upstream:name}` as
literal placeholders for the platform to resolve.

### AnySearch

Package: `@anysearch/anysearch-dsh`. Add upstream `search` with address
`https://api.anysearch.com`, header `Authorization: Bearer {credential}`, and saved
test request `GET /v1/domains`.

Add environment variable `ANYSEARCH_API_KEY` with value `{access-token}`. Enter:

```yaml
web-search-anysearch:
  baseURL: "{upstream:search}"
  apiKeyEnv: ANYSEARCH_API_KEY
```

Select AnySearch as the web search provider in DSH, then perform a search. The
saved upstream test checks connectivity; the search verifies the plugin path.

### modsearch: Tavily or Exa

Package: `@liustack/modsearch`. Add both upstream definitions:

| Name | Example address | Request header |
| --- | --- | --- |
| `tavily` | `https://tavily.example.invalid` | `Authorization: Bearer {credential}` |
| `exa` | `https://exa.example.invalid` | `X-API-Key: {credential}` |

For each, save `POST /search` with JSON body `{"query":"SAMPLE_READY"}`.
The tested configurations enable one engine at a time, through environment variables
only; leave entry YAML empty. Choose one column:

| Environment variable | Tavily configuration | Exa configuration |
| --- | --- | --- |
| `TAVILY_API_KEY` | `{access-token}` | empty |
| `TAVILY_BASE_URL` | `{upstream:tavily}` | `{upstream:tavily}` |
| `EXA_API_KEY` | empty | `{access-token}` |
| `EXA_BASE_URL` | `{upstream:exa}` | `{upstream:exa}` |
| `FIRECRAWL_API_KEY` | empty | empty |
| `FIRECRAWL_BASE_URL` | `{upstream:tavily}/unavailable` | `{upstream:exa}/unavailable` |

“Empty” means an empty field, not the text `empty`. Select modsearch as the DSH
web search provider and perform a search. Firecrawl has no key and is unavailable
in these configurations. Simultaneously enabling Tavily and Exa was not part of
this acceptance.

### dsh-image-gen: OpenAI-compatible service

Package: `dsh-image-gen`. Add upstream `image` with address
`https://images.example.invalid`, header `Authorization: Bearer {credential}`, and
saved test request `GET /v1/models`. Add environment variable
`DSH_IMAGE_GEN_OPENAI_COMPAT_KEY` with value `{access-token}`. Enter:

```yaml
image-gen:
  provider: openai-compat
  openaiCompatBaseURL: "{upstream:image}/v1"
  openaiCompatModel: YOUR_IMAGE_MODEL
  saveToWorkspace: false
```

Use a model supported by your service. The exercised path covers image generation,
multipart image editing, attachment hashes and an upstream wait of over 65 seconds.

### WeKnora: fixed tenant and resource handles

Package: `@wxg-prc-cpg/dsh-weknora`. Add upstream `weknora` with address
`https://weknora.example.invalid` and headers `X-API-Key: {credential}` and
`X-Tenant-ID: YOUR_TENANT_ID`. Save test request `GET /api/v1/knowledge-bases`.
No environment variables are needed. Enter:

```yaml
weknora:
  baseUrl: "{upstream:weknora}/api/v1"
  apiKey: "{access-token}"
  tenantId: YOUR_TENANT_ID
  knowledgeBaseIds:
    - YOUR_KNOWLEDGE_BASE_ID
  resourceUrls: handle
```

Use the same tenant value in the fixed upstream header and entry configuration.
The upstream header controls the forwarded tenant even if a member sends another
value. Acceptance exercised `weknora_ask`, SSE responses and resource handles;
it also verified removal of forged authentication, tenant and cookie headers.
The platform does not rewrite URLs in upstream responses.

## MCP services

MCP services provide tool definitions to the agent. They are managed separately from
plugins in **MCP library**. Adding a service does not grant or publish it.

### Import from the MCP market

Open **MCP library → MCP market** to browse platform-maintained presets. For Amap,
enter a service name and an Amap **Web Service** Key, then select **Import and test**.
The platform stores the Key as a write-only credential and tests the connection.
The services list retains progress across page reloads. A failed or interrupted
import stays unavailable; retry it or delete it. A platform restart marks an
interrupted test as failed so an administrator can retry it explicitly.

A successful import does not grant, publish or enable the service. Grant it to a
group or publish it to the member application center afterwards. Administrators
receive implicit access with their own service disabled by default. Use another
name to import an independent copy. Repeated submissions of the same import do
not create another service.

Market connection settings are maintained by the platform: endpoint, run mode and
authentication templates cannot be edited. Names, credentials, grants, publication,
required policy and disabled tools remain manageable. Credential changes require
a new successful test before the preset becomes available. Manual additions and
JSON imports remain configurable and are never converted into market services by
matching their names. The adopted preset version is recorded for each service.

The **12306** preset needs no Key. After you choose its name, the platform downloads
and verifies the pinned source archive and installs its locked dependencies inside
the shared preparation container. The service shows preparation and connection-test
progress automatically. Open its details for the preparation log; use **Retry import**
if preparation or testing fails. Refreshing does not create another preparation.
A restart preserves the preparation record and marks the interrupted import for
explicit retry; ready dependencies are reused. Each enabled member receives their
own isolated on-demand process with no member files mounted. Rail queries depend
on the provider's current network availability and ticket-sale window.

### Choose a run location

| Location | Use it when | Credentials and member files |
| --- | --- | --- |
| Remote service | The provider exposes a Streamable HTTP MCP endpoint | The gateway attaches platform credentials; member files are not mounted |
| Shared run | A stdio command needs platform credentials but no member files | Each member gets a separate process in an isolated container with read-only prepared dependencies; no member home or workspace is mounted |
| Member container run | A stdio command needs the member's workspace, such as a browser or file tool | Runs inside that member's container; platform credentials are forbidden |

Shared run refers to platform-managed execution, not a single shared MCP session.
It uses the platform execution concurrency, timeout and container resource limits.
Idle processes are reclaimed. Detected Podman is always used for container isolation.
Only when Podman is unavailable does development execution fall back to a host
process, with a warning that it is not isolated. A service needing both platform credentials and member
files requires independent member execution, which is not available.

After idle reclamation, the next call automatically reconnects within the same
DSH session; members do not need to disable and enable the service. Recovery tries
once with a 30-second handshake budget; a later call can retry after failure.
Only a request explicitly rejected because its session expired is resent once.
A disconnected call with an unknown execution result is never automatically
replayed. Check the upstream outcome before repeating writes or other side effects.

Active requests are protected from idle reclamation. The execution timeout applies
to startup and each request, rather than the entire shared process lifetime.
Timeout or cancellation terminates the carrier; the next call may reconnect.
Concurrency, CPU, memory and PID limits still apply. Execution records distinguish
`idle-reclaimed`, `timeout`, `process-exited` and `upstream-error` without storing
tool arguments or results.

### Add, prepare and test

1. Add a service with a `p-` prefixed name and a description. Choose a remote address
   or a command, arguments, environment variables and preparation command.
2. For remote services, put secrets in **Platform credential**, then reference
   `{credential}` in fixed headers or query parameters, for example
   `Authorization: Bearer {credential}` or query parameter `key={credential}`.
   Named credentials use `{credential:name}`. Shared commands can reference these
   placeholders in environment values. Never paste a key into the address,
   arguments or preparation command.
3. For either command location, save and prepare dependencies before testing. Use
   `{dependencies}` in arguments to address the prepared directory. Preparation
   failures leave the service unavailable; inspect the preparation log, correct
   the command and choose **Prepare again**. Runtime calls do not install packages.
4. Choose **Test connection** to discover tools. Testing does not enable the service
   for the administrator. Member-container testing starts the administrator's own
   instance. The tool list is a snapshot: review it again after an upstream change.
5. Select tools to disable, then save. Newly discovered tools are available by
   default. A successful test is required before publishing to all members.
6. Grant the service in group details, or publish it for member selection. Publishing
   a service with platform credentials grants all members the ability to use those
   credentials through the service; review that audience before confirming.

**Import MCP JSON** previews `mcpServers` entries with `url`/`type`/`headers` or
`command`/`args`/`env`. Each entry must be reviewed and saved separately. Suspected
secrets are moved to credential fields for confirmation; review all fields because
this detection is not exhaustive. Imported commands default to Shared run. The
`sse` type is treated as Streamable HTTP; legacy HTTP+SSE transport is unsupported.

### Member access and lifecycle

Open **Platform apps → MCP services** inside DSH. Group-granted services are enabled
by default; administrators receive all services but leave non-required ones disabled
by default. Members can disable optional grants and enable or remove their own
published selections. A required service is locked on only for members who receive
it through a grant, including administrators; publication alone does not force it on.

MCP tool definitions consume model context. Disable unused optional services to
reduce that cost. Changes apply without restarting the member instance; tools refresh
on the next agent request. An MCP name conflict uses the platform entry while it is
effective. The member's own entry is preserved and becomes available again when
platform ownership ends.

Unpublishing clears member selections but retains group grants. Removing a service
clears its grants, selections and saved credentials. Losing all access or disabling
an account rejects subsequent gateway requests. Shared processes are stopped when
their access or configuration changes. Remote credential changes apply to the next
request. Environment reset preserves platform grants and selections.

### Authentication and trust boundaries

OAuth-only services are unavailable. Use a provider's PAT or API token alternative
when offered; the platform does not perform shared or per-member OAuth login.
Signature schemes such as AWS SigV4 and TC3 are unsupported. Credentials are attached
as configured header/query values or shared-process environment values, not signed
per request. Unsupported credential templates fail validation.

Authorized members can use their member token to call the platform gateway outside
the DSH interface. This is permission to use the upstream credential, not to read it.
The platform keeps credential values out of member environment/configuration and
shared-process command arguments; only the isolated shared process receives its
configured secret environment. Review third-party command behavior before supplying
credentials. Filtering tools does not make an untrusted server safe.

Member-container commands cannot use platform credentials, even through templates.
Their files, environment and processes are accessible to that member. Tool filtering
there is a convenience, not a security boundary. The platform neither prevents
members from configuring their own MCP services nor supplies keys for direct access.

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
