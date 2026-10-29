import presets from './download-source-presets.json' with { type: 'json' }
import { BusinessRuleError } from './business-error.js'

export type DownloadSourcePreset = 'official' | 'mainland'
export type DownloadSourceValues = Readonly<typeof presets.official>
export type DownloadSourceCategory = keyof DownloadSourceValues
export interface DownloadSourceSelection {
  readonly preset: DownloadSourcePreset
  readonly overrides?: Partial<DownloadSourceValues>
}
export const downloadSourcePresets: Readonly<Record<DownloadSourcePreset, DownloadSourceValues>> = { official: presets.official, mainland: presets.mainland }
const prefixes: readonly DownloadSourceCategory[] = ['containerMirror', 'ghcrMirror', 'githubAssets', 'githubApi']

export function downloadSourceSelection(input: unknown): DownloadSourceSelection {
  const fail = (): never => {
    throw new BusinessRuleError(
      'invalid',
      'Choose a download preset and HTTP(S) addresses without credentials, queries or fragments.',
      'download-source-invalid',
    )
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
  const row = input as Record<string, unknown>
  if (Object.keys(row).some(key => key !== 'preset' && key !== 'overrides') || (row.preset !== 'official' && row.preset !== 'mainland')) return fail()
  const overrides: Partial<Record<DownloadSourceCategory, string>> = {}
  if (row.overrides !== undefined) {
    if (!row.overrides || typeof row.overrides !== 'object' || Array.isArray(row.overrides)) return fail()
    for (const [name, value] of Object.entries(row.overrides)) {
      if (
        !Object.hasOwn(presets.official, name) ||
        typeof value !== 'string' ||
        value.length > 2048 ||
        value.includes('\\') ||
        /\s/u.test(value) ||
        [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      )
        return fail()
      const key = name as DownloadSourceCategory
      if (value === '' && prefixes.includes(key)) {
        overrides[key] = ''
        continue
      }
      let url: URL
      try {
        url = new URL(value)
      } catch {
        return fail()
      }
      if (
        !/^https?:\/\//iu.test(value) ||
        (Number(url.port) === 0 && url.port !== '') ||
        (['containerMirror', 'ghcrMirror'].includes(key) && url.protocol !== 'https:') ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return fail()
      overrides[key] = url.href.replace(/\/+$/u, '') + (prefixes.includes(key) ? '/' : '')
    }
  }
  return { preset: row.preset, ...(Object.keys(overrides).length ? { overrides } : {}) }
}

export function resolveDownloadSources(selection: DownloadSourceSelection): DownloadSourceValues {
  return { ...downloadSourcePresets[selection.preset], ...selection.overrides }
}

export function downloadSourceEnvironment(sources: DownloadSourceValues, architecture: string): Readonly<Record<string, string>> {
  return {
    NPM_CONFIG_REGISTRY: sources.npm,
    PNPM_CONFIG_REGISTRY: sources.npm,
    COREPACK_NPM_REGISTRY: sources.npm,
    PIP_INDEX_URL: sources.pypi,
    UV_DEFAULT_INDEX: sources.pypi,
    PLAYWRIGHT_DOWNLOAD_HOST: sources.browser,
    GITHUB_ASSETS_PREFIX: sources.githubAssets,
    ...(architecture === 'arm64' ? { PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: sources.browserChromiumArm64 } : {}),
  }
}
