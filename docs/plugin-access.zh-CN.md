# 插件与 MCP 接入

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

## MCP 服务

MCP 服务向 agent 提供工具定义，在「MCP 库」单独管理。添加服务不会自动授权或上架。

### 选择运行位置

| 运行位置 | 适用场景 | 凭据与成员文件 |
| --- | --- | --- |
| 远程服务 | 提供方已有 Streamable HTTP MCP 地址 | 网关附加平台凭据，不挂载成员文件 |
| 共享运行 | stdio 命令需要平台凭据，不需要成员文件 | 每位成员使用隔离容器中的独立进程，只读加载已准备依赖，不挂载成员 home 或工作区 |
| 成员容器运行 | stdio 命令需要成员工作区，例如浏览器或文件工具 | 在该成员容器内运行，禁止使用平台凭据 |

「共享运行」指平台托管执行，不代表成员共用一个 MCP 会话。它使用平台代执行的并发、超时和容器资源限制，空闲进程会被回收。检测到 Podman 时始终使用容器；仅在 Podman 不可用时，开发执行才退化为宿主进程，并提示未隔离。既需要平台凭据、又需要成员文件的服务需要「成员独立运行」，目前不可用。

共享进程空闲回收后，下一次调用会在原 DSH 会话自动恢复连接，无需关闭再开启服务。每次恢复最多尝试一次，握手上限为 30 秒；失败后可再次发起调用。只有明确因会话失效而未执行的请求会在恢复后重发一次。连接中断导致结果未知时不会自动重放，涉及写入或其他副作用时，请先确认上游执行结果。

### 添加、准备与测试

1. 添加以 `p-` 开头的服务名及描述，选择远程地址，或填写命令、参数、环境变量和准备命令。
2. 远程服务的密钥填写在「平台凭据」，在固定请求头或查询参数中用 `{credential}` 引用，例如 `Authorization: Bearer {credential}` 或查询参数 `key={credential}`。命名凭据用 `{credential:name}` 引用。共享命令可在环境变量值中使用这些占位符。不要把 Key 写进地址、命令参数或准备命令。
3. 两种命令运行位置均须先保存并准备依赖，再测试。参数中可用 `{dependencies}` 引用准备后的目录。准备失败时服务不可用；查看准备日志、修正命令，再点击「重新准备」。运行时调用不会安装包。
4. 点击「测试连接」发现工具。测试不会为管理员启用服务；成员容器测试会启动管理员本人的实例。工具列表是快照，上游变化后应重新查看。
5. 勾选要停用的工具并保存。新发现的工具默认可用。上架给全部成员前，必须先通过连接测试。
6. 在分组详情中授权，或上架供成员自选。含平台凭据的服务上架后，全部成员都能通过该服务使用凭据；确认前应检查授权范围。

「导入 MCP JSON」预览 `mcpServers` 中的 `url`/`type`/`headers` 或 `command`/`args`/`env` 配置，必须逐条检查并保存。疑似密钥会移入凭据字段等待确认，但识别并不完整，仍需检查全部字段。导入命令默认采用共享运行。`sse` 类型按 Streamable HTTP 处理，不支持旧式 HTTP+SSE 传输。

### 成员使用与生命周期

在 DSH 内打开「平台应用 → MCP 服务」。分组授权的服务默认启用；管理员自动获得全部服务，但非必选服务默认停用。成员可以停用非必选授权服务，并启用或移除自己的上架自选。必选只对通过授权获得服务的成员锁定启用，包括管理员；仅上架不会强制成员启用。

MCP 工具定义占用模型上下文，可停用暂时不用的非必选服务来减少占用。变更无需重启成员实例，工具在 agent 下一轮请求时更新。MCP 同名冲突时，生效中的平台条目优先；成员自配条目保留，平台不再接管后恢复可用。

取消上架清除成员自选，保留分组授权。移除服务清除其授权、自选和保存的凭据。失去全部使用权限或账户被停用后，后续网关请求会被拒绝。共享进程会在权限或配置变化后停止；远程凭据变化在下一次请求时生效。环境重置保留平台授权和自选。

### 鉴权与信任边界

仅支持 OAuth 的服务暂不可用；提供方有 PAT 或 API Token 方案时，可改用该方案。平台不代办共享或成员个人 OAuth 登录。不支持 AWS SigV4、TC3 等签名鉴权。凭据按配置附加到请求头、查询参数或共享进程环境变量，不会逐请求签名。不支持的凭据模板无法通过校验。

获授权成员可以用自己的成员令牌，在 DSH 界面之外调用平台网关。这是使用上游凭据的权限，不是读取凭据值的权限。平台凭据值不会进入成员环境、配置或共享进程的命令参数；只有隔离共享进程接收其配置的秘密环境变量。提供凭据前应审查第三方命令行为；过滤工具不能让不可信服务变得安全。

成员容器命令禁止使用平台凭据，包括凭据模板。其文件、环境和进程均可被该成员访问，因此这里的工具过滤只用于使用体验，不是安全边界。平台不禁止成员自行配置 MCP 服务，也不为直接访问提供密钥。

## 生命周期

版本变更保留上游和接入配置。新版本缺失的条目 ID 会被标记为失效，这些条目不应用改写，其余条目和环境变量继续应用。

取消发布清除成员自选，保留分组授权。移除插件清除其上游、凭据、接入配置、授权和自选，保留成员原生副本。加载变化在重启后生效；撤权或取消发布导致成员失去全部授权时，下一次上游调用立即被拒绝。停用账户也会立即阻止后续调用。

系统升级和成员环境重置保留平台接入数据及自选记录。重置会清除成员原生自装插件；替代实例按保留的平台配置重新加载。完整行为见[分组与插件](install.zh-CN.md#分组与插件)。

## 接入边界

插件必须支持通过环境变量或配置修改服务地址，并通过请求头携带 Key。平台提供通用转发，不为插件编写专属适配。

平台不强制所有流量走网关，不锁定成员设置，不接管自装插件，不改写上游响应中的 URL，也不提供用量统计或配额。成员可以修改自己的接入配置；直接访问第三方服务时须使用自己的 Key。获授权成员可以用成员令牌调用平台上游，这种使用权限不等于读取平台凭据的权限。
