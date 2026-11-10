# Phalanx 注入 DSH 的界面设计规范

更新日期 2026-11-07。本文记录已确认的设计取舍与当前实现基线。

## 范围与方向

- 适用于 DSH 内的 Phalanx 侧栏入口、账户菜单、账户切换弹窗、平台应用中心及其详情浮层。（用户确认）
- 优先采用 DSH 原生设计规范、公开 UI primitives 和 CSS token。字体、控件外观、明暗主题、焦点与浮层交互跟随宿主。（用户确认）
- 管理后台及独立平台入口页遵循[管理端设计规范](../../admin-ui/DESIGN.md)。恢复页虽然从 DSH 菜单进入，仍属于独立平台页面。（Agent 推断，按渲染边界划分）
- 本文的数值描述当前样板，新增场景先复用宿主组件，再按内容调整布局。（Agent 推断）

## 品牌资产与身份

- 沿用 DSH 的品牌区域和原生图标语言，Phalanx 账户呈现当前平台用户名。（用户确认）
- 平台应用中心使用四个圆角方格组成的线性 SVG，颜色继承 currentColor，线宽与侧栏图标协调。（用户确认）
- 底栏账户头像使用人形图标，当前样板为 28px 正圆底和 18px 图标。显式设置 corner-shape 为 round，使其呈正圆。（用户确认）

## 主题与语义角色

变量由固定 DSH 版本的 ui-theme 提供，原生控件由 ui-primitives 消费。
当前接缝已按 DSH dsh-v0.2.2-rc.1 核对，精确 revision 以 `runtime-versions.json` 为准。升级时复核公开 token、组件和插槽契约。

| DSH token | 用途 | 来源 |
| --- | --- | --- |
| --dsw-alias-label-primary | 标题、名称与主要正文 | 用户确认 |
| --dsw-alias-label-secondary | 状态、操作提示与辅助说明 | Agent 推断 |
| --dsw-alias-label-tertiary | 描述、空态和弱化元信息 | 用户确认 |
| --dsw-alias-label-caption | 分组计数 | Agent 推断 |
| --dsw-alias-border-l3 | 列表分隔线、详情分区边界 | 用户确认 |
| --dsw-alias-interactive-bg-hover / --dsw-alias-interactive-bg-active | 交互反馈，优先交给原生控件 | 用户确认 |
| --dsw-radius-md / --dsw-radius-lg | 自定义入口和图标容器的圆角 | Agent 推断 |
| --dsw-alias-state-error-primary / --dsw-alias-link | 错误与跳转链接 | Agent 推断 |
| --dsw-alias-button-primary-fill / --dsw-alias-label-primary-foreground | 夜间标签激活项的浅色底与深色字 | 用户确认 |

- 明暗主题通过宿主 token 自动适配。夜间主题标记使用宿主的 body[data-ds-dark-theme]。（Agent 推断）
- 夜间应用中心标签的选中项用白色底、深色字。覆盖限定在应用中心 tablist，沿用原生选中指示器。（用户确认）
- 样式使用 Phalanx 局部类，颜色、边框、圆角优先引用宿主 token。原生组件内部的 hover、disabled、focus 与动效交由宿主实现。（用户确认）
- 标题、正文和辅助文字形成层级。样板页主标题为 20px，条目标题为 14px，说明与状态为 13px，详情正文为 14px。（Agent 推断）

## 可用组件

- 组件入口为 @deepseek-ai/dsh-client-ui-primitives。Button、Menu、Modal、Tag、SegmentedTabs、MarkdownText 和原生图标优先复用。
- `src/dsh/community-platform-client.ts` 负责注入入口、侧栏账户行与齿轮菜单。
- `src/dsh/community-account-switch-client.ts` 负责账户切换弹窗与局部布局。
- `src/dsh/community-market-client.ts` 提供应用中心主题适配、列表、分组、动作区与详情浮层的共用类。
- `src/dsh/community-market-shared-client.ts` 的 MarketContent 用于技能正文和技能包串联说明，Markdown 由原生 MarkdownText 渲染。

## 侧栏与账户

- 使用 settings.launcher 展示账户与齿轮同一行，账户靠左、齿轮靠右。第三方插件的 footer 快捷入口保留独立位置。（用户确认）
- 点击账户打开切换账户、重启实例、更多恢复选项、退出登录菜单；当前管理员在首项显示「前往管理后台」，新标签页打开同源管理首页。角色来自页面挂载时的身份响应，变化后刷新更新；未知身份不显示该项，不增加展开查询。点击齿轮打开设置与意见反馈菜单。（用户确认）
- 侧栏底部隐藏 DSH 自身的登录入口，齿轮中的设置调用宿主 openSettings，反馈打开 DSH 默认反馈表单。（用户确认）
- 反馈入口当前直接打开表单，省略原生账户菜单附带的诊断预填信息。（Agent 推断，当前实现）
- 桌面侧栏收起时用头像和齿轮纵向排列，保留可访问名称；小于 768px 使用原生 drawer，关闭时入口不可见且不可交互，先打开侧栏再操作。账户行间距与内边距读取宿主 sidebar 几何变量。用户名超长时省略显示并保留完整名称提示。（Agent 推断）
- 切换弹窗每行分为可选择的账户身份区与右侧操作区。角色、登录状态放在用户名下一行，更多操作保持对齐。（用户确认）
- 底部按钮空间不足时整组换行，账户当前态、重新登录态和不可用态都应可辨识。（Agent 推断）

## 平台应用中心

- 三个横向标签依次为插件、技能、MCP 服务，使用原生 SegmentedTabs。（用户确认）
- 各页签沿用插件页的标题、说明、刷新入口、分组列表和行操作结构。列表承担浏览与选择，详情承载完整内容。（用户确认）
- 可执行的行操作统一使用原生 Button 的 outline、sm 变体，包括安装、卸载、详情和展开技能。（用户确认）
- 页签标题区的刷新操作使用原生图标按钮，保留本地化的可访问名称。状态受控的按钮使用原生 disabled 表现。（Agent 推断）
- MCP 列表和详情使用展示名称与功能说明，按查看语言解析保存的广场默认文案；同名列表附技术服务标识，详情始终显示标识，操作仍按技术标识定位。（用户确认）
- MCP 服务使用 DSH 原生 Switch 表达启停，沿用原生尺寸与主题 token。管理员要求启用的服务保持选中并禁用操作，同时解释限制。（用户确认）
- 技能包在技能页内分组呈现，保留整包安装、卸载与详情；展开内容独占下一行，用缩进和边界表达归属。（用户确认）
- 安装状态、平台管控、失败原因各有独立位置。安装和同步提示根据真实操作结果显示。（Agent 推断）
- 桌面列表正文在左、动作在右。窄屏动作移动到正文下方并换行，条目名称和说明允许折行。（用户确认）

## 详情浮层

- 技能、技能包与 MCP 工具详情共用原生 Modal 和 phalanx-market-dialog 样式。简介使用 Modal 的 description，紧跟标题。（用户确认）
- 技能详情依次展示简介、文件列表（如有）和 Markdown 正文。（用户确认）
- 技能包详情依次展示简介、包含的技能和串联说明。串联说明存在时显示内容标题「串联说明」。（用户确认）
- MCP 工具详情展示服务简介、工具名和工具描述，多工具以间距与细分隔线区分。（用户确认）
- 浮层当前宽度上限为 440px，内容区限制高度并可滚动。浮层经 portal 渲染，其字号与排版使用专用类明确设置。（Agent 推断）
- 标题、说明、列表与正文分区使用紧凑间距，详情分区标题为 14px。关闭按钮、Escape、焦点管理沿用原生 Modal。（用户确认）

## 样板页面

- `src/dsh/community-market-plugins-client.ts` 为应用中心列表与动作的参照。
- `src/dsh/community-market-skills-client.ts`、`src/dsh/community-market-pack-rows.ts` 为技能及技能包详情的参照。
- `src/dsh/community-market-mcp-client.ts` 为服务启停、工具详情和受控状态的参照。

## 维护与验收

- 复用公开接缝，账户行与插件快捷入口按各自插槽呈现。自定义图标需继承宿主颜色并适配侧栏展开和收起状态。（用户确认）
- 原生注入界面使用 DSH token，管理端变量与组件规则由管理端设计文档维护。（用户确认）
- CSS 调整后查看真实 DSH 中的 1440×900 和 390×844 视口，覆盖明暗主题、长名称、空态、失败与主要交互态。（Agent 推断）
- 本地假数据只用于体验和排版检查，业务验收使用真实 API 与相应测试。演示数据及机器相关信息保留在本地工作区。（Agent 推断）
