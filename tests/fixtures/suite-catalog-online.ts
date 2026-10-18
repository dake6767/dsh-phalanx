import { readFileSync } from 'node:fs'
import { withSuiteCatalogContentHash, type SuiteCatalogDocumentEntry, type UnsealedSuiteCatalogDocumentEntry } from '../../src/domain/suite-catalog-document.js'

const text = (en: string, zhCN: string = en) => ({ en, 'zh-CN': zhCN })
const larkSkills = ['lark-approval', 'lark-apps', 'lark-attendance', 'lark-base', 'lark-calendar', 'lark-contact', 'lark-doc', 'lark-drive', 'lark-event', 'lark-im', 'lark-mail', 'lark-markdown', 'lark-meeting', 'lark-minutes',
  'lark-note', 'lark-okr', 'lark-openapi-explorer', 'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-slides', 'lark-task', 'lark-vc', 'lark-vc-agent', 'lark-whiteboard', 'lark-wiki', 'lark-workflow-meeting-summary', 'lark-workflow-standup-report'] as const
const hyperframesSkills = ['general-video', 'hyperframes', 'hyperframes-animation', 'hyperframes-audio', 'hyperframes-cli', 'hyperframes-core', 'hyperframes-creative', 'hyperframes-keyframes',
  'hyperframes-registry', 'hyperframes-studio', 'media-use', 'motion-graphics', 'remotion-to-hyperframes', 'slideshow'] as const
const wecomSkills = ['wecomcli-calendar', 'wecomcli-contact', 'wecomcli-disk', 'wecomcli-doc', 'wecomcli-doc-manage', 'wecomcli-email', 'wecomcli-media', 'wecomcli-meeting', 'wecomcli-message', 'wecomcli-pptx', 'wecomcli-shared', 'wecomcli-sheet', 'wecomcli-smartpage', 'wecomcli-smartsheet', 'wecomcli-todo'] as const

/**
 * Catalog versions are raised above the legacy 0.1.18 record versions (`1`, `3.12.1`, `7.0.2`, `153`) on purpose: the
 * content is the same, but strict SemVer with legacy coercion equates `1` and `1.0.0`, so an equal version would hide
 * the update that moves an old install onto the declarative entry (spec decision 22 / Q24).
 */
const unsealed: readonly UnsealedSuiteCatalogDocumentEntry[] = [
  {
    kind: 'dependency', id: 'pandoc', version: '3.12.2', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('pandoc'), description: text('Universal document converter for Markdown, Word, PDF and more', '通用文档转换器，支持 Markdown、Word、PDF 等格式'),
    source: text('GitHub release jgm/pandoc 3.12.1, static build', 'GitHub Release jgm/pandoc 3.12.1 静态构建'),
    items: [{
      kind: 'runtime-dependency', name: 'pandoc', paths: ['bin'], commands: ['pandoc'], check: { command: 'pandoc', args: ['--version'] },
      downloads: [{
        source: 'github-assets', url: 'https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-{arch}.tar.gz',
        sha256: { amd64: 'd0c90410e90204c9ca83b8539fac5c7aed01fd537207e4585849f8abc5df20b8', arm64: '445d96fd08801fe636cab1158b4f017ee320ac3b7446328b4fe2f902117b19b9' },
        target: 'pandoc.tar.gz', extract: { format: 'tar', directory: 'bin', stripComponents: 2, member: 'pandoc-3.12.1/bin/pandoc' },
      }],
    }],
  },
  {
    kind: 'dependency', id: 'ffmpeg', version: '7.0.3', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('FFmpeg'), description: text('Audio and video encoding with ffmpeg and ffprobe, shared by the suites that need it', '音视频编解码工具 ffmpeg 与 ffprobe，供需要它的套件共用'),
    source: text('GitHub release eugeneware/ffmpeg-static b6.1.1, ffmpeg 7.0.2 static build (GPL)', 'GitHub Release eugeneware/ffmpeg-static b6.1.1，ffmpeg 7.0.2 静态构建（GPL）'),
    items: [{
      kind: 'runtime-dependency', name: 'ffmpeg', paths: ['bin'], commands: ['ffmpeg', 'ffprobe'], check: { command: 'ffmpeg', args: ['-hide_banner', '-version'] },
      downloads: [
        { source: 'github-assets', url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-{nodeArch}',
          sha256: { amd64: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99', arm64: '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce' },
          target: 'bin/ffmpeg', executable: true, timeout: { connectSeconds: 15, totalSeconds: 600 } },
        { source: 'github-assets', url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-{nodeArch}',
          sha256: { amd64: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d', arm64: 'd17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8' },
          target: 'bin/ffprobe', executable: true, timeout: { connectSeconds: 15, totalSeconds: 600 } },
      ],
    }],
  },
  {
    kind: 'dependency', id: 'chromium', version: '154.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('Chromium headless shell', 'Chromium 无头浏览器'), description: text('Headless Chromium for rendering and capture, shared by the suites that need it', '用于渲染与截取的无头 Chromium，供需要它的套件共用'),
    source: text('Playwright chromium-headless-shell (amd64: Chrome for Testing 153.0.8010.12; arm64: Chromium build 1243) through the browser download source',
      '经浏览器下载源取得的 Playwright chromium-headless-shell（amd64：Chrome for Testing 153.0.8010.12；arm64：Chromium 构建 1243）'),
    items: [{
      kind: 'runtime-dependency', name: 'chromium', paths: ['bin'], commands: ['chromium-headless-shell'], check: { command: 'chromium-headless-shell', args: ['--version'] },
      entry: { amd64: 'lib/chrome-headless-shell-linux64/chrome-headless-shell', arm64: 'lib/chrome-linux/headless_shell' },
      downloads: [{
        source: 'browser',
        url: { amd64: 'builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip', arm64: 'builds/chromium/1243/chromium-headless-shell-linux-arm64.zip' },
        sha256: { amd64: 'a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d', arm64: '3a2bc2c354fb66615ee329c2ab13cd1312b40294798bea04c5dc0053caa6b881' },
        target: 'chromium.zip', extract: { format: 'zip', directory: 'lib' }, timeout: { connectSeconds: 15, totalSeconds: 900 },
      }],
    }],
  },
  {
    kind: 'suite', id: 'wecom', version: '2.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: text('WeCom', '企业微信'), description: text('Contacts, documents, sheets, calendar, meetings, mail and messages in WeCom as the signed-in member', '以成员本人身份使用企业微信的通讯录、文档、表格、日程、会议、邮件与消息'),
    source: text('npm @wecom/cli 1.3.4 and skills pinned to WecomTeam/wecom-cli commit f9b28151 (v1.3.4)', 'npm @wecom/cli 1.3.4，技能锁定 WecomTeam/wecom-cli 提交 f9b28151（v1.3.4）'),
    identity: text('Each member signs in as themselves: run `wecom-cli auth init` in the terminal and scan the QR code with WeCom, then check with `wecom-cli auth show --status`. The platform stores no credential; the encrypted sign-in stays in the member home.',
      '成员以本人身份登录：在终端执行 `wecom-cli auth init`，用企业微信扫码授权，再用 `wecom-cli auth show --status` 确认。平台不存储任何凭据，加密的登录信息只留在成员自己的 home。'),
    dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'wecom-tools', paths: ['node_modules/.bin'], commands: ['wecom-cli'], check: { command: 'wecom-cli', args: ['--version'] },
        downloads: [{ source: 'npm', packages: ['@wecom/cli@1.3.4', '@wecom/cli-linux-{nodeArch}@1.3.4'] }] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/WecomTeam/wecom-cli', commit: 'f9b28151dc8d42f703db624fc9b26723c3c93fc5', path: 'skills' }, names: [...wecomSkills], runtimeDependency: 'wecom-tools' },
      { kind: 'skill-pack', name: 'wecom', description: 'WeCom skills with the wecom-cli CLI provided by the platform; each member signs in as themselves.',
        note: 'The wecom-cli CLI is provided by the platform on PATH. Do not run `npm install -g @wecom/cli` or upgrade it. Each member signs in personally: if `wecom-cli auth show --status` is unauthorized, do not run `wecom-cli auth init` yourself; ask the member to run it in their own terminal and scan the QR code with WeCom, then check the status again. These two rules replace the install and initialization steps in wecomcli-shared; keep the other upstream task instructions.',
        skills: [...wecomSkills] },
    ],
  },
  {
    kind: 'suite', id: 'officecli', version: '2.0.0',
    // Adapter wrappers are new in 0.1.19, so the published catalog (ticket 09) must raise this floor to `>=0.1.19`.
    // The fixture keeps `>=0.1.18` only because package.json is still 0.1.18 on this branch.
    engines: { platform: '>=0.1.18' },
    adapters: [{ name: 'fixed-environment', params: { item: 'office-tools', command: 'officecli', environment: { OFFICECLI_SKIP_UPDATE: '1' } } }],
    title: text('OfficeCLI'), description: text('Create and edit .docx, .xlsx and .pptx files in the member workspace', '在成员工作区创建和编辑 docx、xlsx、pptx 文件'),
    source: text('GitHub release iOfficeAI/OfficeCLI v1.0.157 and skills pinned to commit b65272a1', 'GitHub Release iOfficeAI/OfficeCLI v1.0.157，技能锁定提交 b65272a1'),
    identity: text('Runs in the member workspace. No credential is required; members keep their own files.', '在成员工作区内运行。无需凭据，文件归成员自己所有。'),
    dependencies: [], serviceAddresses: [],
    items: [
      { kind: 'runtime-dependency', name: 'office-tools', paths: ['bin'], commands: ['officecli'], check: { command: 'officecli', args: ['--version'] },
        runner: { path: 'lib/officecli' },
        downloads: [{ source: 'github-assets', url: 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157/officecli-linux-{nodeArch}',
          sha256: { amd64: 'f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94', arm64: '60db926c8a1371984b9e99622a834777befb02b6f73d0f3fff914ffcc2760d2f' },
          target: 'lib/officecli', executable: true, timeout: { connectSeconds: 15, totalSeconds: 180 } }] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/iOfficeAI/OfficeCLI', commit: 'b65272a18aef891941451705ff93e8a287f3eb72', path: 'skills' }, names: ['morph-ppt', 'morph-ppt-3d', 'officecli', 'officecli-academic-paper', 'officecli-data-dashboard', 'officecli-docx', 'officecli-financial-model', 'officecli-pitch-deck', 'officecli-pptx', 'officecli-word-form', 'officecli-xlsx'], runtimeDependency: 'office-tools' },
      { kind: 'skill-pack', name: 'officecli-suite', description: 'Office document skills with the officecli CLI provided by the platform.',
        note: 'The officecli CLI is provided by the platform on PATH. Do not run its install or update instructions. Keep the upstream task instructions.',
        skills: ['morph-ppt', 'morph-ppt-3d', 'officecli', 'officecli-academic-paper', 'officecli-data-dashboard', 'officecli-docx', 'officecli-financial-model', 'officecli-pitch-deck', 'officecli-pptx', 'officecli-word-form', 'officecli-xlsx'] },
    ],
  },
  {
    kind: 'suite', id: 'minimax', version: '2.0.0',
    // The normalization adapter is new in 0.1.19, so the published catalog (ticket 09) must raise this floor to
    // `>=0.1.19`. The fixture keeps `>=0.1.18` only because package.json is still 0.1.18 on this branch.
    engines: { platform: '>=0.1.18' },
    adapters: [
      { name: 'refuse', params: { item: 'minimax-tools', command: 'mmx', arguments: ['--base-url', '--verbose', '--region'], message: 'This option is disabled by the platform.' } },
      // 1.0.28 documents --yes for agents but never declares it as a boolean flag. Members keep passing --yes; the
      // wrapper rewrites that standalone token to the upstream-supported --non-interactive flag.
      { name: 'normalize-arguments', params: { item: 'minimax-tools', command: 'mmx', replacements: [{ from: '--yes', to: '--non-interactive' }],
        valueArguments: ['--prompt', '--message', '--text', '--model', '--system', '--name', '--description', '--title', '--query', '--output', '--file', '--url', '--id', '--seed', '--format', '--language', '--style'] } },
      { name: 'credential-argument', params: { item: 'minimax-tools', command: 'mmx', variable: 'MINIMAX_API_KEY', argument: '--api-key' } },
      { name: 'fixed-environment', params: { item: 'minimax-tools', command: 'mmx', environment: { MINIMAX_REGION: 'cn' } } },
    ],
    title: text('MiniMax'), description: text('Generate text, images, video and speech with the team MiniMax account', '使用团队 MiniMax 账户生成文本、图像、视频和语音'),
    source: text('npm mmx-cli 1.0.28 and skill pinned to MiniMax-AI/cli commit a965e72c', 'npm mmx-cli 1.0.28，技能锁定 MiniMax-AI/cli 提交 a965e72c'),
    identity: text('Uses the team API key through platform delegated execution. The key never enters member workspaces; generation consumes the team quota.', '经平台代执行使用团队 API key。凭据不进入成员空间，生成会消耗团队额度。'),
    dependencies: [], serviceAddresses: [],
    items: [
      { kind: 'runtime-dependency', name: 'minimax-tools', paths: ['bin'], commands: ['mmx'], check: { command: 'mmx', args: ['--version'] },
        runner: { command: 'node', path: 'node_modules/mmx-cli/dist/mmx.mjs' },
        downloads: [{ source: 'npm', packages: ['mmx-cli@1.0.28'] }] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/MiniMax-AI/cli', commit: 'a965e72ce424e465ae65ded102315bf73bef0aa3', path: 'skill' }, names: ['mmx-cli'] },
      { kind: 'execution', skill: 'mmx-cli', runtimeDependency: 'minimax-tools', delegated: [{ command: 'mmx', blocked: ['auth', 'config', 'agent', 'update'] }],
        variables: [{ name: 'MINIMAX_API_KEY', purpose: text('Team MiniMax API key (mainland region)', '团队 MiniMax API key（中国大陆区域）') }] },
      { kind: 'skill-pack', name: 'minimax', description: 'MiniMax generation with the team key provided by the platform.',
        note: 'The mmx CLI and its credentials are provided by the platform. Do not run mmx auth, config or update, and do not pass --api-key, --region, --base-url or --verbose. Keep the upstream task instructions. Generation consumes the team quota; save outputs in the workspace.',
        skills: ['mmx-cli'] },
    ],
  },
  {
    kind: 'suite', id: 'lark', version: '2.0.0',
    // The token adapter is new in 0.1.19, so the published catalog (ticket 09) must raise this floor to `>=0.1.19`.
    // The fixture keeps `>=0.1.18` only because package.json is still 0.1.18 on this branch.
    engines: { platform: '>=0.1.18' },
    adapters: [
      { name: 'credential-token', params: { item: 'feishu-tools', command: 'lark-cli',
        request: { url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', method: 'POST', headers: { 'content-type': 'application/json' },
          body: { app_id: { env: 'LARKSUITE_CLI_APP_ID' }, app_secret: { env: 'LARKSUITE_CLI_APP_SECRET' } } },
        responseTokenPath: 'tenant_access_token', environment: 'LARKSUITE_CLI_TENANT_ACCESS_TOKEN', message: 'Bot credentials could not be used.' } },
      { name: 'fixed-environment', params: { item: 'feishu-tools', command: 'lark-cli', environment: { LARKSUITE_CLI_BRAND: 'feishu', LARKSUITE_CLI_DEFAULT_AS: 'bot',
        LARKSUITE_CLI_STRICT_MODE: 'bot', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } } },
    ],
    title: text('Feishu', '飞书'), description: text('Messages, documents, sheets, calendar, approvals and more in Feishu as the team app bot', '以团队应用机器人身份使用飞书的消息、文档、表格、日程、审批等能力'),
    source: text('GitHub release larksuite/cli v1.0.98 and 28 skills pinned to commit ac81f505 (v1.0.98)', 'GitHub Release larksuite/cli v1.0.98，28 个技能锁定提交 ac81f505（v1.0.98）'),
    identity: text('Acts as the team Feishu app bot through platform delegated execution. The administrator enters the App ID and App Secret; they never enter member workspaces. Personal member identity (--as user) is not provided in this version.', '经平台代执行，以团队飞书应用机器人身份操作。App ID 与 App Secret 由管理员填写，不进入成员空间。本版本不提供成员个人身份（--as user）。'),
    dependencies: [], serviceAddresses: ['https://open.feishu.cn'],
    items: [
      { kind: 'runtime-dependency', name: 'feishu-tools', paths: ['bin'], commands: ['lark-cli'], check: { command: 'lark-cli', args: ['--version'] },
        runner: { path: 'lib/lark-cli' },
        downloads: [{ source: 'github-assets', url: 'https://github.com/larksuite/cli/releases/download/v1.0.98/lark-cli-1.0.98-linux-{arch}.tar.gz',
          sha256: { amd64: '4a12dcb7a0aab25986d8bcd046cb45b08278531a9aac3a12b53cf3d94738fe80', arm64: 'f798b26ce4b369d70411945e7f66bbe4382c411bc47d81950a662de7b69b41ed' },
          target: 'lark.tgz', extract: { format: 'tar', directory: 'lib' } }] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/larksuite/cli', commit: 'ac81f5056ab88f37d581d25916f3dab85abfca76', path: 'skills' }, names: [...larkSkills] },
      { kind: 'execution', skill: 'lark-shared', runtimeDependency: 'feishu-tools', delegated: [{ command: 'lark-cli', blocked: ['config', 'auth', 'profile', 'update'] }],
        variables: [{ name: 'LARKSUITE_CLI_APP_ID', purpose: text('Feishu app ID of the team bot', '团队机器人的飞书应用 App ID') }, { name: 'LARKSUITE_CLI_APP_SECRET', purpose: text('Feishu app secret of the team bot', '团队机器人的飞书应用 App Secret') }] },
      { kind: 'skill-pack', name: 'lark', description: 'Feishu skills with lark-cli run by the platform as the team app bot.',
        note: 'lark-cli and its app credentials are provided by platform delegated execution as the team app bot. Use `--as bot`; personal identity (`--as user`) is not available. Do not run `lark-cli config`, `auth`, `profile` or `update`, and do not install or upgrade lark-cli. When a command reports missing scopes or `console_url`, show it to the member and ask an administrator to grant the scope. Keep the other upstream task instructions.',
        skills: [...larkSkills] },
    ],
  },
  {
    kind: 'suite', id: 'hyperframes', version: '2.0.0',
    // Same engines note as lark: ticket 09 raises this to `>=0.1.19` because all four adapters below are new in 0.1.19.
    engines: { platform: '>=0.1.18' },
    adapters: [
      { name: 'refuse', params: { item: 'hyperframes-tools', command: 'hyperframes', subcommands: ['skills', 'upgrade'],
        valueArguments: ['--output', '--port', '--composition', '--project', '--input', '--config', '--template', '--format', '--fps', '--width', '--height', '--quality', '--crf', '--duration', '--concurrency', '--browser', '--scale', '--audio', '--name', '--dir'],
        message: 'HyperFrames skills and CLI are provided by the platform; this command is disabled.' } },
      // Only Chromium needs an explicit path: the upstream CLI discovers FFmpeg itself, and 0.1.18 set only this env.
      { name: 'link-shared-dependency', params: { item: 'hyperframes-tools', command: 'hyperframes', dependency: 'chromium', executable: 'chromium-headless-shell',
        environment: 'HYPERFRAMES_BROWSER_PATH', requireUnlessVersion: true, missingMessage: 'The platform Chromium dependency is unavailable.' } },
      { name: 'fixed-environment', params: { item: 'hyperframes-tools', command: 'hyperframes', environment: { HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1',
        HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_SKIP_SKILLS: '1' } } },
      { name: 'intercept-npx', params: { item: 'hyperframes-tools', command: 'npx', packages: ['hyperframes'], route: 'hyperframes' } },
    ],
    title: text('HyperFrames'), description: text('Write HTML video compositions and render them to MP4 in the member workspace', '编写 HTML 视频合成，并在成员工作区渲染成 MP4'),
    source: text('npm hyperframes 0.8.167 and 14 skills pinned to heygen-com/hyperframes commit 35b17c3f (v0.8.167)', 'npm hyperframes 0.8.167，14 个技能锁定 heygen-com/hyperframes 提交 35b17c3f（v0.8.167）'),
    identity: text('Renders locally in the member workspace with the shared Chromium and FFmpeg; telemetry is off. No HeyGen account is configured, so HeyGen voice, music, avatars and cloud rendering are unavailable unless a member signs in themselves.', '使用共用的 Chromium 与 FFmpeg 在成员工作区本地渲染，遥测已关闭。平台不配置 HeyGen 账户：HeyGen 配音、配乐、数字人与云渲染不可用，除非成员本人自行登录。'),
    dependencies: ['ffmpeg', 'chromium'],
    // Rendering happens locally with the shared dependencies; no network service address is used at runtime.
    serviceAddresses: [],
    items: [
      { kind: 'runtime-dependency', name: 'hyperframes-tools', paths: ['bin'], commands: ['hyperframes', 'npx'], check: { command: 'hyperframes', args: ['--version'] },
        runner: { command: 'node', path: 'node_modules/hyperframes/bin/hyperframes.mjs' },
        downloads: [{ source: 'npm', packages: ['hyperframes@0.8.167'] }] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/heygen-com/hyperframes', commit: '35b17c3fe6cdf7e40d252f1d813b0a2cecec6a94', path: 'skills' }, names: [...hyperframesSkills], runtimeDependency: 'hyperframes-tools', catalogDependencies: ['ffmpeg', 'chromium'] },
      { kind: 'skill-pack', name: 'hyperframes-suite', description: 'HyperFrames video skills with the CLI, Chromium and FFmpeg provided by the platform.',
        note: 'The hyperframes CLI, Chromium and FFmpeg are provided by the platform on PATH, and all HyperFrames skills in this pack are already installed and release-managed. Do not run `npx hyperframes skills update`, `skills check`, `npx skills add`, `hyperframes upgrade`, `browser ensure` or any npm install for HyperFrames; when a skill asks you to install or refresh a workflow, read the bundled skill of that name instead. Use `hyperframes` from PATH, not `npx hyperframes`. Run in the project directory inside the workspace; if `init` reports a permission error, run `chmod -R u+w` on the new project and continue. Workflows not in this pack (captions, talking-head recut, music-to-video, PR and Figma videos) are not provided. Keep the other upstream task instructions.',
        skills: [...hyperframesSkills] },
    ],
  },
]

/** Catalog CI feeds its actual publication into the existing equivalence assertions. Tests alone accept this path. */
const publicationFile = process.env.DSH_PHALANX_CATALOG_TEST_FILE
export const onlineCatalogEntries: readonly SuiteCatalogDocumentEntry[] = publicationFile
  ? (JSON.parse(readFileSync(publicationFile, 'utf8')) as { entries: SuiteCatalogDocumentEntry[] }).entries
  : unsealed.map(withSuiteCatalogContentHash)

/** The preparation commands 0.1.18 shipped; the generated equivalents must match byte for byte where the style allows. */
export const legacyPrepareCommands: Readonly<Record<string, Readonly<Record<'amd64' | 'arm64', string>>>> = {
  pandoc: {
    amd64: 'curl --fail --location --silent --show-error "${GITHUB_ASSETS_PREFIX}https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-amd64.tar.gz" -o pandoc.tar.gz && echo "d0c90410e90204c9ca83b8539fac5c7aed01fd537207e4585849f8abc5df20b8  pandoc.tar.gz" | sha256sum -c - && mkdir -p bin && tar xzf pandoc.tar.gz --strip-components=2 -C bin pandoc-3.12.1/bin/pandoc && rm pandoc.tar.gz',
    arm64: 'curl --fail --location --silent --show-error "${GITHUB_ASSETS_PREFIX}https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-arm64.tar.gz" -o pandoc.tar.gz && echo "445d96fd08801fe636cab1158b4f017ee320ac3b7446328b4fe2f902117b19b9  pandoc.tar.gz" | sha256sum -c - && mkdir -p bin && tar xzf pandoc.tar.gz --strip-components=2 -C bin pandoc-3.12.1/bin/pandoc && rm pandoc.tar.gz',
  },
  ffmpeg: {
    amd64: `set -eu\nmkdir -p bin\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64" -o bin/ffmpeg\necho "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99  bin/ffmpeg" | sha256sum -c -\nchmod +x bin/ffmpeg\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-x64" -o bin/ffprobe\necho "4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d  bin/ffprobe" | sha256sum -c -\nchmod +x bin/ffprobe`,
    arm64: `set -eu\nmkdir -p bin\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-arm64" -o bin/ffmpeg\necho "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce  bin/ffmpeg" | sha256sum -c -\nchmod +x bin/ffmpeg\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-arm64" -o bin/ffprobe\necho "d17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8  bin/ffprobe" | sha256sum -c -\nchmod +x bin/ffprobe`,
  },
  chromium: {
    amd64: `set -eu\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "\${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip" -o chromium.zip\necho "a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d  chromium.zip" | sha256sum -c -\nmkdir -p lib bin\nunzip -q chromium.zip -d lib\nrm chromium.zip\nln -s ../lib/chrome-headless-shell-linux64/chrome-headless-shell bin/chromium-headless-shell`,
    arm64: `set -eu\ncurl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "\${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/chromium/1243/chromium-headless-shell-linux-arm64.zip" -o chromium.zip\necho "3a2bc2c354fb66615ee329c2ab13cd1312b40294798bea04c5dc0053caa6b881  chromium.zip" | sha256sum -c -\nmkdir -p lib bin\nunzip -q chromium.zip -d lib\nrm chromium.zip\nln -s ../lib/chrome-linux/headless_shell bin/chromium-headless-shell`,
  },
  wecom: {
    amd64: 'set -eu\nnpm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund @wecom/cli@1.3.4 @wecom/cli-linux-x64@1.3.4',
    arm64: 'set -eu\nnpm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund @wecom/cli@1.3.4 @wecom/cli-linux-arm64@1.3.4',
  },
}

/** The exact 0.1.18 OfficeCLI preparation command; the generated wrapper must reproduce it byte for byte. */
export const legacyOfficecliPrepareCommands: Readonly<Record<'amd64' | 'arm64', string>> = {
  amd64: `set -eu
mkdir -p lib bin
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 180 "\${GITHUB_ASSETS_PREFIX}https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157/officecli-linux-x64" -o lib/officecli
echo "f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94  lib/officecli" | sha256sum -c -
chmod +x lib/officecli
printf '%s\\n' '#!/bin/sh' 'export OFFICECLI_SKIP_UPDATE=1' 'exec "$(dirname "$(readlink -f "$0")")/../lib/officecli" "$@"' > bin/officecli
chmod +x bin/officecli`,
  arm64: `set -eu
mkdir -p lib bin
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 180 "\${GITHUB_ASSETS_PREFIX}https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157/officecli-linux-arm64" -o lib/officecli
echo "60db926c8a1371984b9e99622a834777befb02b6f73d0f3fff914ffcc2760d2f  lib/officecli" | sha256sum -c -
chmod +x lib/officecli
printf '%s\\n' '#!/bin/sh' 'export OFFICECLI_SKIP_UPDATE=1' 'exec "$(dirname "$(readlink -f "$0")")/../lib/officecli" "$@"' > bin/officecli
chmod +x bin/officecli`,
}
