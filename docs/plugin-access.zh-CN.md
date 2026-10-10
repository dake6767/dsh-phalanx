# 插件接入

[English](plugin-access.md)

平台应用是管理员在插件库中预检并提供给成员的插件。分组授权提供「平台预装」；成员自行选择的应用来自「平台应用中心」。两种方式都只读加载，跟随管理员选用的版本。

插件上游保存服务地址、请求头和平台凭据。接入配置把环境变量及按条目 ID 合并的配置提供给成员实例。获授权成员可以使用平台凭据，但无法从成员空间读出其值。

## 配置步骤

1. 在「插件库」添加精确版本或上传 `.tgz`，等待预检通过。
2. 打开插件详情中的「接入配置」，添加插件上游。地址支持 HTTP(S) 和内网地址；名称只在当前插件内使用。
3. 在「平台凭据」填写真实 Key。在请求头中用 `{credential}` 引用，例如 `Authorization: Bearer {credential}` 或 `X-API-Key: {credential}`。固定请求头覆盖成员提交的同名值，可用于锁定租户。
4. 保存测试请求，点击「测试已保存的请求」。它只验证地址、凭据和请求头；仍需配置接入并实际调用插件，才能确认完整链路。
5. 在环境变量或条目配置中，用 `{upstream:name}` 引用转发地址，用 `{access-token}` 引用成员令牌。这里不要填写真实 Key。环境变量对整个实例生效，会覆盖成员已有的同名变量；同一个变量名只能由一个平台应用配置，平台保留变量不可改写。
6. 按界面列出的条目 ID 填写 YAML。对象逐层合并，数组和标量整体替换；不支持 YAML 标签或表达式。保存后，受影响成员重启实例才会加载新配置。
7. 为分组设置平台预装授权，或发布给全体成员自选。含平台凭据的应用发布前，需要确认全体成员都将获得使用该凭据的权限。

上游地址、请求头和平台凭据更新后，下一次请求即使用新值，不要求成员重启。删除仍被接入配置引用的上游时，界面会指出引用位置。

## 接入示例

以下配置均已验证分组授权和成员自选两种方式。AnySearch 使用真实上游，其余样本使用受控协议夹具。请把 `.example.invalid` 地址、模型、租户和知识库标识替换成自己的服务值。每条上游的真实 Key 只填写在该上游的「平台凭据」中；`{credential}`、`{access-token}` 和 `{upstream:name}` 保持原样，由平台解析。

### AnySearch

包名：`@anysearch/anysearch-dsh`。添加上游 `search`，地址为 `https://api.anysearch.com`，请求头为 `Authorization: Bearer {credential}`，保存测试请求 `GET /v1/domains`。

添加环境变量 `ANYSEARCH_API_KEY`，值为 `{access-token}`。条目配置填写：

```yaml
web-search-anysearch:
  baseURL: "{upstream:search}"
  apiKeyEnv: ANYSEARCH_API_KEY
```

在 DSH 中将网页搜索提供者选为 AnySearch，再执行一次搜索。上游测试检查连通性，实际搜索用于验证插件调用链路。

### modsearch：Tavily 或 Exa

包名：`@liustack/modsearch`。添加以下两条上游：

| 名称 | 示例地址 | 请求头 |
| --- | --- | --- |
| `tavily` | `https://tavily.example.invalid` | `Authorization: Bearer {credential}` |
| `exa` | `https://exa.example.invalid` | `X-API-Key: {credential}` |

两条上游均保存测试请求 `POST /search`，JSON 请求体为 `{"query":"SAMPLE_READY"}`。实际验证的配置每次只启用一个搜索引擎，仅使用环境变量，条目 YAML 留空。从以下两列选择一种：

| 环境变量 | Tavily 配置 | Exa 配置 |
| --- | --- | --- |
| `TAVILY_API_KEY` | `{access-token}` | 留空 |
| `TAVILY_BASE_URL` | `{upstream:tavily}` | `{upstream:tavily}` |
| `EXA_API_KEY` | 留空 | `{access-token}` |
| `EXA_BASE_URL` | `{upstream:exa}` | `{upstream:exa}` |
| `FIRECRAWL_API_KEY` | 留空 | 留空 |
| `FIRECRAWL_BASE_URL` | `{upstream:tavily}/unavailable` | `{upstream:exa}/unavailable` |

“留空”指空值，不要填写“留空”这两个字。在 DSH 中将网页搜索提供者选为 modsearch，再执行搜索。上述配置不给 Firecrawl 提供 Key，Firecrawl 不可用。本次验收未覆盖同时启用 Tavily 和 Exa 的配置。

### dsh-image-gen：OpenAI 兼容服务

包名：`dsh-image-gen`。添加上游 `image`，地址为 `https://images.example.invalid`，请求头为 `Authorization: Bearer {credential}`，保存测试请求 `GET /v1/models`。添加环境变量 `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY`，值为 `{access-token}`。条目配置填写：

```yaml
image-gen:
  provider: openai-compat
  openaiCompatBaseURL: "{upstream:image}/v1"
  openaiCompatModel: YOUR_IMAGE_MODEL
  saveToWorkspace: false
```

模型名称请使用上游实际支持的值。已验证的调用包含图片生成、multipart 图片编辑、附件摘要，以及超过 65 秒的上游等待。

### WeKnora：固定租户与资源句柄

包名：`@wxg-prc-cpg/dsh-weknora`。添加上游 `weknora`，地址为 `https://weknora.example.invalid`，请求头为 `X-API-Key: {credential}` 和 `X-Tenant-ID: YOUR_TENANT_ID`，保存测试请求 `GET /api/v1/knowledge-bases`。不需要环境变量，条目配置填写：

```yaml
weknora:
  baseUrl: "{upstream:weknora}/api/v1"
  apiKey: "{access-token}"
  tenantId: YOUR_TENANT_ID
  knowledgeBaseIds:
    - YOUR_KNOWLEDGE_BASE_ID
  resourceUrls: handle
```

固定上游请求头和条目配置中填写同一个租户值。即使成员提交其他值，实际转发仍由上游固定请求头决定。验收覆盖 `weknora_ask`、SSE 响应和资源句柄，并验证伪造的认证头、租户头和 Cookie 被丢弃。平台不改写上游响应中的 URL。

## 生命周期

版本变更保留上游和接入配置。新版本缺失的条目 ID 会被标记为失效，这些条目不应用改写，其余条目和环境变量继续应用。

取消发布清除成员自选，保留分组授权。移除插件清除其上游、凭据、接入配置、授权和自选，保留成员原生副本。加载变化在重启后生效；撤权或取消发布导致成员失去全部授权时，下一次上游调用立即被拒绝。停用账户也会立即阻止后续调用。

系统升级和成员环境重置保留平台接入数据及自选记录。重置会清除成员原生自装插件；替代实例按保留的平台配置重新加载。完整行为见[分组与插件](install.zh-CN.md#分组与插件)。

## 接入边界

插件必须支持通过环境变量或配置修改服务地址，并通过请求头携带 Key。平台提供通用转发，不为插件编写专属适配。

平台不强制所有流量走网关，不锁定成员设置，不接管自装插件，不改写上游响应中的 URL，也不提供用量统计或配额。成员可以修改自己的接入配置；直接访问第三方服务时须使用自己的 Key。获授权成员可以用成员令牌调用平台上游，这种使用权限不等于读取平台凭据的权限。
