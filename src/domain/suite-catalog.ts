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

/** Why a signed catalog entry cannot be installed on this platform or deployment. */
export type SuiteCatalogEntryUnavailable = 'needs-platform-upgrade' | 'unknown-adapter' | 'invalid-adapter-params' | 'content-hash-mismatch' | 'content-tampered' | 'invalid-entry'
interface SuiteCatalogEntryCommon {
  /** Immutable content identity of an online entry; bundled legacy entries leave it unset. */
  readonly contentHash?: string
  /** Signed entries this platform refuses keep their card but cannot be installed. */
  readonly unavailableReason?: SuiteCatalogEntryUnavailable
  /** Diagnostic from the catalog checks; display-only. */
  readonly unavailableDetail?: string
}
export interface SuiteCatalogDependencyEntry extends SuiteCatalogEntryCommon {
  readonly category: 'dependency'
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly items: readonly SuiteCatalogItem[]
}
export interface SuiteCatalogSuiteEntry extends SuiteCatalogEntryCommon {
  readonly category: 'suite'
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly identity: Readonly<Record<'en' | 'zh-CN', string>>
  readonly dependencies: readonly string[]
  /** Runtime service addresses the administrator can audit for egress requirements. */
  readonly serviceAddresses?: readonly string[]
  readonly items: readonly SuiteCatalogItem[]
}
export type SuiteCatalogEntry = SuiteCatalogDependencyEntry | SuiteCatalogSuiteEntry

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
  // The pinned CLI documents --yes but omits its boolean metadata. Fix the metadata, preserving argument values.
  "node <<'JS'",
  "const fs=require('node:fs');",
  "const file=process.env.RD_OUT+'/node_modules/mmx-cli/dist/mmx.mjs';",
  "const source=fs.readFileSync(file,'utf8');",
  "const marker='rn=[{flag:\"--api-key <key>\"';",
  "if(source.split(marker).length!==2)throw Error('Unexpected MiniMax CLI option metadata');",
  "fs.writeFileSync(file,source.replace(marker,'rn=[{flag:\"--yes\",description:\"Skip confirmation prompts\"},{flag:\"--api-key <key>\"'));",
  'JS',
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

// 0.1.15 accepted bot-identity wrapper: exchanges the app credentials for a tenant token in the isolated process only.
const larkDefinition = (asset: 'amd64' | 'arm64', sha256: string): string => [
  'set -eu',
  'mkdir bin lib',
  `curl --fail --location --silent --show-error --connect-timeout 15 --max-time 180 "\${GITHUB_ASSETS_PREFIX}https://github.com/larksuite/cli/releases/download/v1.0.98/lark-cli-1.0.98-linux-${asset}.tar.gz" -o lark.tgz`,
  `echo "${sha256}  lark.tgz" | sha256sum -c -`,
  'tar xzf lark.tgz -C lib',
  'rm lark.tgz',
  "cat > bin/lark-cli <<'JS'",
  '#!/usr/bin/env node',
  "const {spawnSync}=require('node:child_process');",
  "const path=require('node:path');",
  '(async()=>{',
  "  const env={...process.env,LARKSUITE_CLI_BRAND:'feishu',LARKSUITE_CLI_DEFAULT_AS:'bot',LARKSUITE_CLI_STRICT_MODE:'bot',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'};",
  '  if(env.LARKSUITE_CLI_APP_ID && env.LARKSUITE_CLI_APP_SECRET){',
  "    const response=await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:env.LARKSUITE_CLI_APP_ID,app_secret:env.LARKSUITE_CLI_APP_SECRET}),signal:AbortSignal.timeout(15000)});",
  '    const result=await response.json();',
  "    if(!response.ok || result.code!==0 || !result.tenant_access_token) throw Error('Bot token unavailable');",
  '    env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN=result.tenant_access_token;',
  '  }',
  "  const child=spawnSync(path.join(__dirname,'../lib/lark-cli'),process.argv.slice(2),{stdio:'inherit',env});",
  '  if(child.error)throw child.error;',
  '  process.exitCode=child.status??1;',
  "})().catch(()=>{console.error('Bot credentials could not be used.');process.exitCode=1});",
  'JS',
  'chmod +x bin/lark-cli',
].join('\n')
const larkSkills = ['lark-approval', 'lark-apps', 'lark-attendance', 'lark-base', 'lark-calendar', 'lark-contact', 'lark-doc', 'lark-drive', 'lark-event', 'lark-im', 'lark-mail', 'lark-markdown', 'lark-meeting', 'lark-minutes',
  'lark-note', 'lark-okr', 'lark-openapi-explorer', 'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-slides', 'lark-task', 'lark-vc', 'lark-vc-agent', 'lark-whiteboard', 'lark-wiki', 'lark-workflow-meeting-summary', 'lark-workflow-standup-report'] as const

const officecliSkills = ['morph-ppt', 'morph-ppt-3d', 'officecli', 'officecli-academic-paper', 'officecli-data-dashboard', 'officecli-docx', 'officecli-financial-model', 'officecli-pitch-deck', 'officecli-pptx', 'officecli-word-form', 'officecli-xlsx'] as const

/** Versioned platform presets, bundled with the release; no remote directory is read. */
export const suiteCatalog: readonly SuiteCatalogEntry[] = [
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
    category: 'suite', id: 'lark', version: '1',
    title: { en: 'Feishu', 'zh-CN': '飞书' },
    description: { en: 'Messages, documents, sheets, calendar, approvals and more in Feishu as the team app bot', 'zh-CN': '以团队应用机器人身份使用飞书的消息、文档、表格、日程、审批等能力' },
    source: { en: 'GitHub release larksuite/cli v1.0.98 and 28 skills pinned to commit ac81f505 (v1.0.98)', 'zh-CN': 'GitHub Release larksuite/cli v1.0.98，28 个技能锁定提交 ac81f505（v1.0.98）' },
    identity: { en: 'Acts as the team Feishu app bot through platform delegated execution. The administrator enters the App ID and App Secret; they never enter member workspaces. Personal member identity (--as user) is not provided in this version.', 'zh-CN': '经平台代执行，以团队飞书应用机器人身份操作。App ID 与 App Secret 由管理员填写，不进入成员空间。本版本不提供成员个人身份（--as user）。' },
    dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'feishu-tools', prepareCommands: { amd64: larkDefinition('amd64', '4a12dcb7a0aab25986d8bcd046cb45b08278531a9aac3a12b53cf3d94738fe80'), arm64: larkDefinition('arm64', 'f798b26ce4b369d70411945e7f66bbe4382c411bc47d81950a662de7b69b41ed') },
        pathDirectories: ['bin'], checkCommand: 'lark-cli --version', commands: ['lark-cli'] },
      // Delegation alone puts lark-cli on the member PATH, so it appears only once the app credentials are configured.
      { kind: 'skill', source: { type: 'git', url: 'https://github.com/larksuite/cli', commit: 'ac81f5056ab88f37d581d25916f3dab85abfca76', path: 'skills' }, names: [...larkSkills] },
      { kind: 'execution', skill: 'lark-shared', runtimeDependency: 'feishu-tools', delegated: [{ command: 'lark-cli', blocked: ['config', 'auth', 'profile', 'update'] }],
        variables: [{ name: 'LARKSUITE_CLI_APP_ID', purpose: { en: 'Feishu app ID of the team bot', 'zh-CN': '团队机器人的飞书应用 App ID' } }, { name: 'LARKSUITE_CLI_APP_SECRET', purpose: { en: 'Feishu app secret of the team bot', 'zh-CN': '团队机器人的飞书应用 App Secret' } }] },
      { kind: 'skill-pack', name: 'lark', description: 'Feishu skills with lark-cli run by the platform as the team app bot.',
        note: 'lark-cli and its app credentials are provided by platform delegated execution as the team app bot. Use `--as bot`; personal identity (`--as user`) is not available. Do not run `lark-cli config`, `auth`, `profile` or `update`, and do not install or upgrade lark-cli. When a command reports missing scopes or `console_url`, show it to the member and ask an administrator to grant the scope. Keep the other upstream task instructions.',
        skills: [...larkSkills] },
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

/** A manual entry an install takes over in place. */
export interface SuiteReplacedEntry { readonly kind: 'runtime-dependency' | 'skill', readonly name: string }
export interface SuiteInstallRequest {
  readonly id: string
  readonly requestId: string
  readonly groups?: readonly string[]
  readonly publish?: boolean
  /** Delegated execution variable values; held in memory for the task only, never in the install record. */
  readonly credentials?: Readonly<Record<string, string>>
  /** The manual entries the confirmed preview listed for replacement; the install is refused if the plan differs. */
  readonly replace?: readonly SuiteReplacedEntry[]
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
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'requestId', 'groups', 'publish', 'credentials', 'replace'].includes(key))
    || typeof (value as { id?: unknown }).id !== 'string' || typeof (value as { requestId?: unknown }).requestId !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/u.test((value as { requestId: string }).requestId)) throw invalidRequest()
  const request = value as { id: string, requestId: string, groups?: unknown, publish?: unknown, credentials?: unknown, replace?: unknown }
  if (request.replace !== undefined && (!Array.isArray(request.replace) || request.replace.length > 256 || request.replace.some(row => !row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).some(key => key !== 'kind' && key !== 'name') || (row.kind !== 'runtime-dependency' && row.kind !== 'skill') || typeof row.name !== 'string'))) throw invalidRequest()
  if (request.groups !== undefined && (!Array.isArray(request.groups) || request.groups.length > 64 || request.groups.some(group => typeof group !== 'string'))
    || request.publish !== undefined && typeof request.publish !== 'boolean') throw invalidRequest()
  const credentials = request.credentials === undefined ? undefined : suiteCredentialsInput(request.credentials)
  return { id: request.id, requestId: request.requestId, ...(request.groups !== undefined ? { groups: request.groups as readonly string[] } : {}), ...(request.publish !== undefined ? { publish: request.publish } : {}),
    ...(credentials && Object.keys(credentials).length ? { credentials } : {}), ...(Array.isArray(request.replace) && request.replace.length ? { replace: (request.replace as readonly SuiteReplacedEntry[]).map(row => ({ kind: row.kind, name: row.name })) } : {}) }
}

/** Resolves the per-architecture definition of a runtime dependency item. */
export function suiteRuntimeDependencyDefinition(item: SuiteCatalogRuntimeDependencyItem, architecture: SuiteCatalogArchitecture): CommunityRuntimeDependencyInput | undefined {
  const prepareCommand = item.prepareCommands[architecture]
  if (!prepareCommand) return undefined
  return { name: item.name, prepareCommand, pathDirectories: [...item.pathDirectories], ...(item.checkCommand ? { checkCommand: item.checkCommand } : {}) }
}

/** Typed refusal for a signed entry this platform will not install; the view already shows the reason. */
export function suiteCatalogRefusal(reason: SuiteCatalogEntryUnavailable): BusinessRuleError {
  if (reason === 'needs-platform-upgrade') return new BusinessRuleError('invalid', 'This catalog entry requires a newer platform version.', 'suite-platform-upgrade-required')
  if (reason === 'content-tampered') return new BusinessRuleError('conflict', 'The catalog content for this version changed after it was installed.', 'suite-catalog-content-tampered')
  if (reason === 'unknown-adapter') return new BusinessRuleError('invalid', 'This catalog entry needs a platform adapter that is not available.', 'suite-adapter-unavailable')
  if (reason === 'invalid-entry') return new BusinessRuleError('invalid', 'The catalog entry failed the platform download checks.', 'suite-catalog-entry-rejected')
  if (reason === 'invalid-adapter-params') return new BusinessRuleError('invalid', 'The catalog entry has invalid adapter parameters.', 'suite-adapter-params-invalid')
  return new BusinessRuleError('invalid', 'The catalog entry content does not match its declared hash.', 'suite-catalog-integrity-failed')
}

/** Friendly catalog name for an install origin, used by library badges. */
export function suiteOriginName(origin: string, locale: 'en' | 'zh-CN' = 'en'): string {
  const entry = suiteCatalog.find(row => `suite:${row.id}` === origin && row.category === 'suite')
  return entry ? entry.title[locale] : origin.replace(/^suite:/u, '')
}
