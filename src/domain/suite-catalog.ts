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
