import { BusinessRuleError } from './business-error.js'
import type { CommunityRuntimeDependencyInput } from './admin-contract.js'

/** Preparation commands are keyed by deployment architecture; a missing key means unavailable. */
export type SuiteCatalogArchitecture = 'amd64' | 'arm64'
export type SuiteCatalogItemKind = 'runtime-dependency'

/** One installable unit. Every kind implements the same plan/prepare/commit/rollback/uninstall operations. */
export interface SuiteCatalogRuntimeDependencyItem {
  readonly kind: 'runtime-dependency'
  readonly name: string
  readonly prepareCommands: Readonly<Partial<Record<SuiteCatalogArchitecture, string>>>
  readonly pathDirectories: readonly string[]
  readonly checkCommand?: string
  readonly commands: readonly string[]
}
export type SuiteCatalogItem = SuiteCatalogRuntimeDependencyItem

export interface SuiteCatalogDependencyEntry {
  readonly category: 'dependency'
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly source: Readonly<Record<'en' | 'zh-CN', string>>
  readonly items: readonly SuiteCatalogItem[]
}
export type SuiteCatalogEntry = SuiteCatalogDependencyEntry

const pandocDefinition = (architecture: 'amd64' | 'arm64', sha256: string): string => [
  `curl --fail --location --silent --show-error "\${GITHUB_ASSETS_PREFIX}https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-${architecture}.tar.gz" -o pandoc.tar.gz`,
  `echo "${sha256}  pandoc.tar.gz" | sha256sum -c -`,
  'mkdir -p bin',
  `tar xzf pandoc.tar.gz --strip-components=2 -C bin pandoc-3.12.1/bin/pandoc`,
  'rm pandoc.tar.gz',
].join(' && ')

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
]

export function suiteInstallInput(value: unknown): { id: string, requestId: string } {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'requestId'].includes(key))
    || typeof (value as { id?: unknown }).id !== 'string' || typeof (value as { requestId?: unknown }).requestId !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/u.test((value as { requestId: string }).requestId)) throw new BusinessRuleError('invalid', 'Invalid suite catalog request.', 'suite-catalog-invalid')
  return { id: (value as { id: string }).id, requestId: (value as { requestId: string }).requestId }
}

/** Resolves the per-architecture definition of a runtime dependency item. */
export function suiteRuntimeDependencyDefinition(item: SuiteCatalogRuntimeDependencyItem, architecture: SuiteCatalogArchitecture): CommunityRuntimeDependencyInput | undefined {
  const prepareCommand = item.prepareCommands[architecture]
  if (!prepareCommand) return undefined
  return { name: item.name, prepareCommand, pathDirectories: [...item.pathDirectories], ...(item.checkCommand ? { checkCommand: item.checkCommand } : {}) }
}
