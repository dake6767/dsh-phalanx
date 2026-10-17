import { BusinessRuleError } from './business-error.js'
import type { CommunityRuntimeDependencyInput } from './admin-contract.js'

/** Preparation commands are keyed by deployment architecture; a missing key means unavailable. */
export type SuiteCatalogArchitecture = 'amd64' | 'arm64'
export type SuiteCatalogItemKind = 'runtime-dependency' | 'skill' | 'skill-pack' | 'execution'

/** One installable unit. Every kind implements the same plan/prepare/commit/rollback/uninstall operations. */
export interface SuiteCatalogRuntimeDependencyItem {
  readonly kind: 'runtime-dependency'
  readonly name: string
  readonly prepareCommands: Readonly<Partial<Record<SuiteCatalogArchitecture, string>>>
  readonly pathDirectories: readonly string[]
  readonly checkCommand?: string
  readonly commands: readonly string[]
}
export interface SuiteCatalogSkillSource {
  readonly type: 'git'
  readonly url: string
  readonly commit: string
  readonly path: string
}
export interface SuiteCatalogSkillItem {
  readonly kind: 'skill'
  readonly source: SuiteCatalogSkillSource
  readonly names: readonly string[]
  /** Suite runtime-dependency item that puts these skills' commands on the member PATH; omitted when only delegated execution provides them. */
  readonly runtimeDependency?: string
  /** Shared catalog dependency ids (from the suite's `dependencies`) these skills also need on PATH. */
  readonly catalogDependencies?: readonly string[]
}
export interface SuiteCatalogSkillPackItem {
  readonly kind: 'skill-pack'
  readonly name: string
  readonly description: string
  readonly note: string
  readonly skills: readonly string[]
}
/** Delegated execution template: names and purposes only; administrators supply variable values. */
export interface SuiteCatalogExecutionItem {
  readonly kind: 'execution'
  /** Suite skill that owns the configuration. */
  readonly skill: string
  readonly runtimeDependency: string
  readonly delegated: readonly { readonly command: string, readonly blocked: readonly string[] }[]
  readonly variables: readonly { readonly name: string, readonly purpose: Readonly<Record<'en' | 'zh-CN', string>> }[]
}
export type SuiteCatalogItem = SuiteCatalogRuntimeDependencyItem | SuiteCatalogSkillItem | SuiteCatalogSkillPackItem | SuiteCatalogExecutionItem

export interface SuiteCatalogDependencyEntry {
  readonly category: 'dependency'
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly items: readonly SuiteCatalogItem[]
}
export interface SuiteCatalogSuiteEntry {
  readonly category: 'suite'
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly identity: Readonly<Record<'en' | 'zh-CN', string>>
  readonly dependencies: readonly string[]
  readonly items: readonly SuiteCatalogItem[]
}
export type SuiteCatalogEntry = SuiteCatalogDependencyEntry | SuiteCatalogSuiteEntry

const pandocDefinition = (architecture: 'amd64' | 'arm64', sha256: string): string => [
  `curl --fail --location --silent --show-error "\${GITHUB_ASSETS_PREFIX}https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-${architecture}.tar.gz" -o pandoc.tar.gz`,
  `echo "${sha256}  pandoc.tar.gz" | sha256sum -c -`,
  'mkdir -p bin',
  `tar xzf pandoc.tar.gz --strip-components=2 -C bin pandoc-3.12.1/bin/pandoc`,
  'rm pandoc.tar.gz',
].join(' && ')

const officecliDefinition = (asset: 'x64' | 'arm64', sha256: string): string => [
  'set -eu',
  'mkdir -p lib bin',
  `curl --fail --location --silent --show-error --connect-timeout 15 --max-time 180 "\${GITHUB_ASSETS_PREFIX}https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157/officecli-linux-${asset}" -o lib/officecli`,
  `echo "${sha256}  lib/officecli" | sha256sum -c -`,
  'chmod +x lib/officecli',
  "printf '%s\\n' '#!/bin/sh' 'export OFFICECLI_SKIP_UPDATE=1' 'exec \"$(dirname \"$(readlink -f \"$0\")\")/../lib/officecli\" \"$@\"' > bin/officecli",
  'chmod +x bin/officecli',
].join('\n')

// The configured npm download source supplies the registry; the wrapper keeps the key inside the isolated process.
const minimaxDefinition = [
  'set -eu',
  'npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund mmx-cli@1.0.28',
  'mkdir bin',
  "cat > bin/mmx <<'JS'",
  '#!/usr/bin/env node',
  "const {spawnSync}=require('node:child_process');",
  "const path=require('node:path');",
  'const args=process.argv.slice(2);',
  "if(args.some(arg=>/^(--base-url|--verbose|--region)(=|$)/.test(arg))){console.error('This option is disabled by the platform.');process.exit(2)}",
  'const key=process.env.MINIMAX_API_KEY;',
  "const extra=key?['--api-key',key]:[];",
  "const result=spawnSync(process.execPath,[path.join(__dirname,'../node_modules/mmx-cli/dist/mmx.mjs'),...args,...extra],{stdio:'inherit',env:{...process.env,MINIMAX_REGION:'cn'}});",
  "if(result.error){console.error('MiniMax CLI could not start.');process.exit(1)}",
  'process.exit(result.status??1);',
  'JS',
  'chmod +x bin/mmx',
].join('\n')

const ffmpegDefinition = (asset: 'x64' | 'arm64', ffmpeg: string, ffprobe: string): string => [
  'set -eu',
  'mkdir -p bin',
  ...(['ffmpeg', 'ffprobe'] as const).flatMap(name => [
    `curl --fail --location --silent --show-error --connect-timeout 15 --max-time 600 "\${GITHUB_ASSETS_PREFIX}https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${name}-linux-${asset}" -o bin/${name}`,
    `echo "${name === 'ffmpeg' ? ffmpeg : ffprobe}  bin/${name}" | sha256sum -c -`,
    `chmod +x bin/${name}`,
  ]),
].join('\n')

// The platform package is named explicitly so a skipped optional dependency fails preparation instead of the first call.
const wecomDefinition = (asset: 'x64' | 'arm64'): string => [
  'set -eu',
  `npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund @wecom/cli@1.3.4 @wecom/cli-linux-${asset}@1.3.4`,
].join('\n')
const wecomSkills = ['wecomcli-calendar', 'wecomcli-contact', 'wecomcli-disk', 'wecomcli-doc', 'wecomcli-doc-manage', 'wecomcli-email', 'wecomcli-media', 'wecomcli-meeting', 'wecomcli-message', 'wecomcli-pptx', 'wecomcli-shared', 'wecomcli-sheet', 'wecomcli-smartpage', 'wecomcli-smartsheet', 'wecomcli-todo'] as const

// Playwright's headless shell through the browser download source; `unzip` keeps the executable bits.
const chromiumDefinition = (url: string, sha256: string, directory: string, binary: string, hostVariable: string): string => [
  'set -eu',
  `curl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "\${${hostVariable}:-https://cdn.playwright.dev}/${url}" -o chromium.zip`,
  `echo "${sha256}  chromium.zip" | sha256sum -c -`,
  'mkdir -p lib bin',
  'unzip -q chromium.zip -d lib',
  'rm chromium.zip',
  `ln -s ../lib/${directory}/${binary} bin/chromium-headless-shell`,
].join('\n')

// The wrapper pins the browser to the shared Chromium dependency, turns telemetry and self-updates off, and refuses
// the `skills` subcommand so read-only platform skills are never replaced by unpinned copies in the member home.
const hyperframesDefinition = [
  'set -eu',
  'npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund hyperframes@0.8.167',
  'mkdir bin',
  "cat > bin/hyperframes <<'SH'",
  '#!/bin/sh',
  'for arg in "$@"; do case "$arg" in -*) ;; skills|upgrade) echo "HyperFrames skills and CLI are provided by the platform; this command is disabled." >&2; exit 2;; *) break;; esac; done',
  // The preparation check runs with only this dependency on PATH, so `--version` must not need the browser.
  'browser="$(command -v chromium-headless-shell || true)"',
  'if [ -z "$browser" ] && [ "${1:-}" != --version ]; then echo "The platform Chromium dependency is unavailable." >&2; exit 1; fi',
  'if [ -n "$browser" ]; then export HYPERFRAMES_BROWSER_PATH="$(readlink -f "$browser")"; fi',
  'export HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1 HYPERFRAMES_SKIP_SKILLS=1',
  'exec node "$(dirname "$(readlink -f "$0")")/../node_modules/hyperframes/bin/hyperframes.mjs" "$@"',
  'SH',
  // Upstream skills call `npx hyperframes`, which would fetch an unwrapped copy; route that package to the wrapper.
  "cat > bin/npx <<'SH'",
  '#!/bin/sh',
  'self="$(readlink -f "$0")"',
  'for arg in "$@"; do case "$arg" in hyperframes|hyperframes@*|--package=hyperframes|--package=hyperframes@*) hit=1; break;; -p|--package) next=1;; *) [ "${next:-}" = 1 ] && case "$arg" in hyperframes|hyperframes@*) hit=1; break;; esac; next=;; esac; done',
  'if [ "${hit:-}" = 1 ]; then',
  '  while [ "$#" -gt 0 ]; do case "$1" in -p|--package) shift 2;; -*) shift;; *) shift; break;; esac; done',
  '  exec "$(dirname "$self")/hyperframes" "$@"',
  'fi',
  'old_ifs="$IFS"; IFS=:; set -f',
  'for dir in $PATH; do',
  '  candidate="$dir/npx"',
  '  if [ -f "$candidate" ] && [ -x "$candidate" ] && [ "$(readlink -f "$candidate")" != "$self" ] && ! grep -q "route that package to the platform wrapper" "$candidate" 2>/dev/null; then IFS="$old_ifs"; set +f; exec "$candidate" "$@"; fi',
  'done',
  'echo "npx is not available." >&2; exit 127',
  '# route that package to the platform wrapper',
  'SH',
  'chmod +x bin/hyperframes bin/npx',
].join('\n')
// First batch from ticket 01. Excluded: skills that need ML engines, a GitHub or Figma account or Python audio libraries;
// product-launch-video and faceless-explainer are deferred until silent/bring-your-own-voiceover use is documented.
const hyperframesSkills = ['general-video', 'hyperframes', 'hyperframes-animation', 'hyperframes-audio', 'hyperframes-cli', 'hyperframes-core', 'hyperframes-creative', 'hyperframes-keyframes',
  'hyperframes-registry', 'hyperframes-studio', 'media-use', 'motion-graphics', 'remotion-to-hyperframes', 'slideshow'] as const

const officecliSkills = ['morph-ppt', 'morph-ppt-3d', 'officecli', 'officecli-academic-paper', 'officecli-data-dashboard', 'officecli-docx', 'officecli-financial-model', 'officecli-pitch-deck', 'officecli-pptx', 'officecli-word-form', 'officecli-xlsx'] as const

/** Versioned platform presets, bundled with the release; no remote directory is read. */
export const suiteCatalog: readonly SuiteCatalogEntry[] = [
  {
    category: 'dependency', id: 'pandoc', version: '3.12.1',
    title: { en: 'pandoc', 'zh-CN': 'pandoc' },
    description: { en: 'Universal document converter for Markdown, Word, PDF and more', 'zh-CN': '通用文档转换器，支持 Markdown、Word、PDF 等格式' },
    source: { en: 'GitHub release jgm/pandoc 3.12.1, static build', 'zh-CN': 'GitHub Release jgm/pandoc 3.12.1 静态构建' },
    items: [{ kind: 'runtime-dependency', name: 'pandoc',
      prepareCommands: { amd64: pandocDefinition('amd64', 'd0c90410e90204c9ca83b8539fac5c7aed01fd537207e4585849f8abc5df20b8'), arm64: pandocDefinition('arm64', '445d96fd08801fe636cab1158b4f017ee320ac3b7446328b4fe2f902117b19b9') },
      pathDirectories: ['bin'], checkCommand: 'pandoc --version', commands: ['pandoc'] }],
  },
  {
    category: 'dependency', id: 'ffmpeg', version: '7.0.2',
    title: { en: 'FFmpeg', 'zh-CN': 'FFmpeg' },
    description: { en: 'Audio and video encoding with ffmpeg and ffprobe, shared by the suites that need it', 'zh-CN': '音视频编解码工具 ffmpeg 与 ffprobe，供需要它的套件共用' },
    source: { en: 'GitHub release eugeneware/ffmpeg-static b6.1.1, ffmpeg 7.0.2 static build (GPL)', 'zh-CN': 'GitHub Release eugeneware/ffmpeg-static b6.1.1，ffmpeg 7.0.2 静态构建（GPL）' },
    items: [{ kind: 'runtime-dependency', name: 'ffmpeg',
      prepareCommands: {
        amd64: ffmpegDefinition('x64', 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99', '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d'),
        arm64: ffmpegDefinition('arm64', '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce', 'd17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8'),
      },
      pathDirectories: ['bin'], checkCommand: 'ffmpeg -hide_banner -version', commands: ['ffmpeg', 'ffprobe'] }],
  },
  {
    category: 'dependency', id: 'chromium', version: '153',
    title: { en: 'Chromium headless shell', 'zh-CN': 'Chromium 无头浏览器' },
    description: { en: 'Headless Chromium for rendering and capture, shared by the suites that need it', 'zh-CN': '用于渲染与截取的无头 Chromium，供需要它的套件共用' },
    source: { en: 'Playwright chromium-headless-shell (amd64: Chrome for Testing 153.0.8010.12; arm64: Chromium build 1243) through the browser download source', 'zh-CN': '经浏览器下载源取得的 Playwright chromium-headless-shell（amd64：Chrome for Testing 153.0.8010.12；arm64：Chromium 构建 1243）' },
    items: [{ kind: 'runtime-dependency', name: 'chromium',
      prepareCommands: {
        amd64: chromiumDefinition('builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip', 'a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d', 'chrome-headless-shell-linux64', 'chrome-headless-shell', 'PLAYWRIGHT_DOWNLOAD_HOST'),
        arm64: chromiumDefinition('builds/chromium/1243/chromium-headless-shell-linux-arm64.zip', '3a2bc2c354fb66615ee329c2ab13cd1312b40294798bea04c5dc0053caa6b881', 'chrome-linux', 'headless_shell', 'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST'),
      },
      pathDirectories: ['bin'], checkCommand: 'chromium-headless-shell --version', commands: ['chromium-headless-shell'] }],
  },
  {
    category: 'suite', id: 'hyperframes', version: '1',
    title: { en: 'HyperFrames', 'zh-CN': 'HyperFrames' },
    description: { en: 'Write HTML video compositions and render them to MP4 in the member workspace', 'zh-CN': '编写 HTML 视频合成，并在成员工作区渲染成 MP4' },
    source: { en: 'npm hyperframes 0.8.167 and 14 skills pinned to heygen-com/hyperframes commit 35b17c3f (v0.8.167)', 'zh-CN': 'npm hyperframes 0.8.167，14 个技能锁定 heygen-com/hyperframes 提交 35b17c3f（v0.8.167）' },
    identity: { en: 'Renders locally in the member workspace with the shared Chromium and FFmpeg; telemetry is off. No HeyGen account is configured, so HeyGen voice, music, avatars and cloud rendering are unavailable unless a member signs in themselves.', 'zh-CN': '使用共用的 Chromium 与 FFmpeg 在成员工作区本地渲染，遥测已关闭。平台不配置 HeyGen 账户：HeyGen 配音、配乐、数字人与云渲染不可用，除非成员本人自行登录。' },
    dependencies: ['ffmpeg', 'chromium'],
    items: [
      { kind: 'runtime-dependency', name: 'hyperframes-tools', prepareCommands: { amd64: hyperframesDefinition, arm64: hyperframesDefinition }, pathDirectories: ['bin'], checkCommand: 'hyperframes --version', commands: ['hyperframes', 'npx'] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/heygen-com/hyperframes', commit: '35b17c3fe6cdf7e40d252f1d813b0a2cecec6a94', path: 'skills' }, names: [...hyperframesSkills], runtimeDependency: 'hyperframes-tools', catalogDependencies: ['ffmpeg', 'chromium'] },
      { kind: 'skill-pack', name: 'hyperframes-suite', description: 'HyperFrames video skills with the CLI, Chromium and FFmpeg provided by the platform.',
        note: 'The hyperframes CLI, Chromium and FFmpeg are provided by the platform on PATH, and all HyperFrames skills in this pack are already installed and release-managed. Do not run `npx hyperframes skills update`, `skills check`, `npx skills add`, `hyperframes upgrade`, `browser ensure` or any npm install for HyperFrames; when a skill asks you to install or refresh a workflow, read the bundled skill of that name instead. Use `hyperframes` from PATH, not `npx hyperframes`. Run in the project directory inside the workspace; if `init` reports a permission error, run `chmod -R u+w` on the new project and continue. Workflows not in this pack (captions, talking-head recut, music-to-video, PR and Figma videos) are not provided. Keep the other upstream task instructions.',
        skills: [...hyperframesSkills] },
    ],
  },
  {
    category: 'suite', id: 'officecli', version: '1',
    title: { en: 'OfficeCLI', 'zh-CN': 'OfficeCLI' },
    description: { en: 'Create and edit .docx, .xlsx and .pptx files in the member workspace', 'zh-CN': '在成员工作区创建和编辑 docx、xlsx、pptx 文件' },
    source: { en: 'GitHub release iOfficeAI/OfficeCLI v1.0.157 and skills pinned to commit b65272a1', 'zh-CN': 'GitHub Release iOfficeAI/OfficeCLI v1.0.157，技能锁定提交 b65272a1' },
    identity: { en: 'Runs in the member workspace. No credential is required; members keep their own files.', 'zh-CN': '在成员工作区内运行。无需凭据，文件归成员自己所有。' },
    dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'office-tools',
        prepareCommands: { amd64: officecliDefinition('x64', 'f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94'), arm64: officecliDefinition('arm64', '60db926c8a1371984b9e99622a834777befb02b6f73d0f3fff914ffcc2760d2f') },
        pathDirectories: ['bin'], checkCommand: 'officecli --version', commands: ['officecli'] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/iOfficeAI/OfficeCLI', commit: 'b65272a18aef891941451705ff93e8a287f3eb72', path: 'skills' }, names: [...officecliSkills], runtimeDependency: 'office-tools' },
      { kind: 'skill-pack', name: 'officecli-suite', description: 'Office document skills with the officecli CLI provided by the platform.',
        note: 'The officecli CLI is provided by the platform on PATH. Do not run its install or update instructions. Keep the upstream task instructions.',
        skills: [...officecliSkills] },
    ],
  },
  {
    category: 'suite', id: 'wecom', version: '1',
    title: { en: 'WeCom', 'zh-CN': '企业微信' },
    description: { en: 'Contacts, documents, sheets, calendar, meetings, mail and messages in WeCom as the signed-in member', 'zh-CN': '以成员本人身份使用企业微信的通讯录、文档、表格、日程、会议、邮件与消息' },
    source: { en: 'npm @wecom/cli 1.3.4 and skills pinned to WecomTeam/wecom-cli commit f9b28151 (v1.3.4)', 'zh-CN': 'npm @wecom/cli 1.3.4，技能锁定 WecomTeam/wecom-cli 提交 f9b28151（v1.3.4）' },
    identity: { en: 'Each member signs in as themselves: run `wecom-cli auth init` in the terminal and scan the QR code with WeCom, then check with `wecom-cli auth show --status`. The platform stores no credential; the encrypted sign-in stays in the member home.', 'zh-CN': '成员以本人身份登录：在终端执行 `wecom-cli auth init`，用企业微信扫码授权，再用 `wecom-cli auth show --status` 确认。平台不存储任何凭据，加密的登录信息只留在成员自己的 home。' },
    dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'wecom-tools', prepareCommands: { amd64: wecomDefinition('x64'), arm64: wecomDefinition('arm64') }, pathDirectories: ['node_modules/.bin'], checkCommand: 'wecom-cli --version', commands: ['wecom-cli'] },
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/WecomTeam/wecom-cli', commit: 'f9b28151dc8d42f703db624fc9b26723c3c93fc5', path: 'skills' }, names: [...wecomSkills], runtimeDependency: 'wecom-tools' },
      { kind: 'skill-pack', name: 'wecom', description: 'WeCom skills with the wecom-cli CLI provided by the platform; each member signs in as themselves.',
        note: 'The wecom-cli CLI is provided by the platform on PATH. Do not run `npm install -g @wecom/cli` or upgrade it. Each member signs in personally: if `wecom-cli auth show --status` is unauthorized, do not run `wecom-cli auth init` yourself; ask the member to run it in their own terminal and scan the QR code with WeCom, then check the status again. These two rules replace the install and initialization steps in wecomcli-shared; keep the other upstream task instructions.',
        skills: [...wecomSkills] },
    ],
  },
  {
    category: 'suite', id: 'minimax', version: '1',
    title: { en: 'MiniMax', 'zh-CN': 'MiniMax' },
    description: { en: 'Generate text, images, video and speech with the team MiniMax account', 'zh-CN': '使用团队 MiniMax 账户生成文本、图像、视频和语音' },
    source: { en: 'npm mmx-cli 1.0.28 and skill pinned to MiniMax-AI/cli commit a965e72c', 'zh-CN': 'npm mmx-cli 1.0.28，技能锁定 MiniMax-AI/cli 提交 a965e72c' },
    identity: { en: 'Uses the team API key through platform delegated execution. The key never enters member workspaces; generation consumes the team quota.', 'zh-CN': '经平台代执行使用团队 API key。凭据不进入成员空间，生成会消耗团队额度。' },
    dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'minimax-tools', prepareCommands: { amd64: minimaxDefinition, arm64: minimaxDefinition }, pathDirectories: ['bin'], checkCommand: 'mmx --version', commands: ['mmx'] },
      // Delegation alone puts mmx on the member PATH, so it appears only once the team key is configured.
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/MiniMax-AI/cli', commit: 'a965e72ce424e465ae65ded102315bf73bef0aa3', path: 'skill' }, names: ['mmx-cli'] },
      { kind: 'execution', skill: 'mmx-cli', runtimeDependency: 'minimax-tools', delegated: [{ command: 'mmx', blocked: ['auth', 'config', 'agent', 'update'] }],
        variables: [{ name: 'MINIMAX_API_KEY', purpose: { en: 'Team MiniMax API key (mainland region)', 'zh-CN': '团队 MiniMax API key（中国大陆区域）' } }] },
      { kind: 'skill-pack', name: 'minimax', description: 'MiniMax generation with the team key provided by the platform.',
        note: 'The mmx CLI and its credentials are provided by the platform. Do not run mmx auth, config or update, and do not pass --api-key, --region, --base-url or --verbose. Keep the upstream task instructions. Generation consumes the team quota; save outputs in the workspace.',
        skills: ['mmx-cli'] },
    ],
  },
]

export interface SuiteInstallRequest {
  readonly id: string
  readonly requestId: string
  readonly groups?: readonly string[]
  readonly publish?: boolean
  /** Delegated execution variable values; held in memory for the task only, never in the install record. */
  readonly credentials?: Readonly<Record<string, string>>
}

export const invalidRequest = () => new BusinessRuleError('invalid', 'Invalid suite catalog request.', 'suite-catalog-invalid')

/** Blank values are skipped so a wizard may leave credentials for later. */
export function suiteCredentialsInput(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw invalidRequest()
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([name, secret]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || typeof secret !== 'string' || secret.length > 65536 || secret.includes('\0'))) throw invalidRequest()
  return Object.fromEntries((entries as [string, string][]).filter(([, secret]) => secret.trim() !== ''))
}

export interface SuiteUninstallRequest {
  /** Shared catalog dependencies to remove with the suite; only unreferenced ones are accepted. */
  readonly removeDependencies?: readonly string[]
}

export function suiteUninstallInput(value: unknown): SuiteUninstallRequest {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'removeDependencies')) throw invalidRequest()
  const remove = (value as { removeDependencies?: unknown }).removeDependencies
  if (remove !== undefined && (!Array.isArray(remove) || remove.length > 64 || remove.some(id => typeof id !== 'string'))) throw invalidRequest()
  return remove === undefined ? {} : { removeDependencies: [...new Set(remove as string[])] }
}

export function suiteInstallInput(value: unknown): SuiteInstallRequest {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'requestId', 'groups', 'publish', 'credentials'].includes(key))
    || typeof (value as { id?: unknown }).id !== 'string' || typeof (value as { requestId?: unknown }).requestId !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/u.test((value as { requestId: string }).requestId)) throw invalidRequest()
  const request = value as { id: string, requestId: string, groups?: unknown, publish?: unknown, credentials?: unknown }
  if (request.groups !== undefined && (!Array.isArray(request.groups) || request.groups.length > 64 || request.groups.some(group => typeof group !== 'string'))
    || request.publish !== undefined && typeof request.publish !== 'boolean') throw invalidRequest()
  const credentials = request.credentials === undefined ? undefined : suiteCredentialsInput(request.credentials)
  return { id: request.id, requestId: request.requestId, ...(request.groups !== undefined ? { groups: request.groups as readonly string[] } : {}), ...(request.publish !== undefined ? { publish: request.publish } : {}),
    ...(credentials && Object.keys(credentials).length ? { credentials } : {}) }
}

/** Resolves the per-architecture definition of a runtime dependency item. */
export function suiteRuntimeDependencyDefinition(item: SuiteCatalogRuntimeDependencyItem, architecture: SuiteCatalogArchitecture): CommunityRuntimeDependencyInput | undefined {
  const prepareCommand = item.prepareCommands[architecture]
  if (!prepareCommand) return undefined
  return { name: item.name, prepareCommand, pathDirectories: [...item.pathDirectories], ...(item.checkCommand ? { checkCommand: item.checkCommand } : {}) }
}

/** Friendly catalog name for an install origin, used by library badges. */
export function suiteOriginName(origin: string, locale: 'en' | 'zh-CN' = 'en'): string {
  const entry = suiteCatalog.find(row => `suite:${row.id}` === origin && row.category === 'suite')
  return entry ? entry.title[locale] : origin.replace(/^suite:/u, '')
}
