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
