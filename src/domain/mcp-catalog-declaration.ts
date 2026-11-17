import type { CommunityMcpInput } from './admin-contract.js'
import type { McpPreset } from './mcp-catalog.js'
import { validateMcpSettings } from './mcp-service.js'
import type { SuiteCatalogDocumentReservedEntry, SuiteCatalogLocalized } from './suite-catalog-document.js'

export type VerifiedMcpPreset = McpPreset & { readonly entry: McpPreset['entry'] & { readonly contentHash: string } }

const baseFields = ['kind', 'id', 'version', 'engines', 'contentHash', 'adapters', 'title', 'description', 'source', 'documentation']
const sharedFields = ['repository', 'commit', 'sha256', 'script']

/** Compile data into the same settings the service owner validates for local configuration. */
export function compileMcpCatalogDeclaration(entry: SuiteCatalogDocumentReservedEntry, raw: Record<string, unknown>): VerifiedMcpPreset | undefined {
  const documentation = httpsUrl(raw.documentation)
  if (!documentation || !exactRecord(raw, baseFields) || !exactRecord(raw.engines, ['platform'])) return
  if (['title', 'description', 'source'].some(field => !catalogLabel(raw[field]))) return
  if (entry.adapters.length !== 1 || !Array.isArray(raw.adapters) || !exactRecord(raw.adapters[0], ['name', 'params'])) return
  const { name, params } = entry.adapters[0]!
  let settings: { configuration: McpPreset['configuration']; credentialLabel?: SuiteCatalogLocalized }
  if (name === 'mcp-remote-http') {
    const remote = remoteSettings(params)
    if (!remote) return
    settings = remote
  } else if (name === 'mcp-shared-node') {
    const run = sharedRunner(params)
    if (!run) return
    settings = { configuration: { description: '', url: '', run } }
  } else {
    return
  }
  const configuration = { ...settings.configuration, description: entry.title.en }
  try {
    validateMcpSettings({ ...configuration, name: 'p-catalog-validation' })
  } catch {
    return
  }
  return {
    entry: {
      id: entry.id,
      version: entry.version,
      contentHash: entry.contentHash,
      title: entry.title,
      description: entry.description,
      documentation,
      location: configuration.run ? 'shared' : 'remote',
      imported: 0,
      ...(settings.credentialLabel ? { credentialLabel: settings.credentialLabel } : {}),
    },
    configuration,
  }
}

function remoteSettings(params: Readonly<Record<string, unknown>>):
  | {
      configuration: McpPreset['configuration']
      credentialLabel?: SuiteCatalogLocalized
    }
  | undefined {
  const url = httpsUrl(params.url)
  if (!url || new URL(url).search) return
  const base = { description: '', url, run: null, headers: [], query: [] }
  if (exactRecord(params, ['url'])) return { configuration: base }
  if (!exactRecord(params, ['url', 'credential'])) return
  const binding = params.credential
  if (!exactRecord(binding, ['label', 'in', 'name', 'template'])) return
  const { label, in: placement, name, template } = binding
  if (
    !catalogLabel(label) ||
    (placement !== 'headers' && placement !== 'query') ||
    typeof name !== 'string' ||
    typeof template !== 'string' ||
    !/^[^{}]*\{credential\}[^{}]*$/u.test(template)
  )
    return
  return { configuration: { ...base, [placement]: [{ name, value: template }] }, credentialLabel: label }
}

function sharedRunner(params: Readonly<Record<string, unknown>>): CommunityMcpInput['run'] | undefined {
  if (!exactRecord(params, sharedFields)) return
  const { repository, commit, sha256, script } = params
  if (
    typeof repository !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_.-]*$/iu.test(repository) ||
    typeof commit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(commit) ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    typeof script !== 'string' ||
    !/^(?:[a-z0-9_-][a-z0-9_.-]*\/)*[a-z0-9_-][a-z0-9_.-]*\.js$/iu.test(script)
  )
    return
  const prepareCommand = [
    `curl --fail --location --silent --show-error https://codeload.github.com/${repository}/tar.gz/${commit} -o source.tar.gz`,
    `echo "${sha256}  source.tar.gz" | sha256sum -c -`,
    'mkdir source && tar xzf source.tar.gz -C source --strip-components=1',
    'npm ci --prefix source --omit=dev --ignore-scripts --no-audit --no-fund',
    'rm source.tar.gz',
  ].join(' && ')
  return { location: 'shared', command: 'node', args: [`{dependencies}/source/${script}`], env: [], prepareCommand }
}

function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^https:\/\/[^{}\s\\]+$/u.test(raw)) return
  const url = URL.parse(raw)
  if (url?.hostname && !url.username && !url.password && !url.hash) return raw
}

function exactRecord<T extends string>(value: unknown, fields: readonly T[]): value is Record<T, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value!).length === fields.length &&
    fields.every(field => Object.hasOwn(value!, field))
  )
}

function catalogLabel(value: unknown): value is SuiteCatalogLocalized {
  return (
    exactRecord(value, ['en', 'zh-CN']) &&
    Object.values(value).every(label => typeof label === 'string' && label.length <= 512 && Boolean(label.trim()) && !/[\p{Cc}\p{Cf}]/u.test(label))
  )
}
