import { mergeMcpDisplay } from './mcp-display.js'
import { hasMcpDefaultCredentialSlot } from './mcp-protocol.js'
import type { CommunityMcpCatalogEntry, CommunityMcpCatalogInput, CommunityMcpInput } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'

export interface McpPreset {
  readonly entry: CommunityMcpCatalogEntry
  readonly configuration: Omit<CommunityMcpInput, 'name' | 'credential'>
}
export function catalogInput(input: CommunityMcpCatalogInput, presets: readonly McpPreset[]): CommunityMcpInput {
  const preset = presets.find(row => row.entry.id === input?.presetId)
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some(key => !['presetId', 'name', 'credential', 'requestId', 'display', 'version', 'contentHash'].includes(key)) ||
    !preset ||
    typeof input.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(input.requestId) ||
    typeof input.credential !== 'string' ||
    (preset.entry.credentialLabel ? !preset.entry.credentialOptional && !input.credential.trim() : Boolean(input.credential))
  )
    throw new BusinessRuleError('invalid', 'Invalid MCP market input.', 'mcp-service-invalid')
  return {
    run: null,
    headers: [],
    query: [],
    ...preset.configuration,
    name: input.name,
    display: mergeMcpDisplay(input.display, {
      defaults: { name: structuredClone(preset.entry.title), description: structuredClone(preset.entry.description) },
    })!,
    ...(input.credential.trim() ? { credential: input.credential } : {}),
  }
}
export function assertCatalogConfiguration(previous: import('./mcp-service.js').McpService, input: CommunityMcpInput): void {
  if (!previous.catalog) return
  const changed =
    input.url !== previous.url ||
    input.description !== previous.description ||
    (input.run !== undefined && JSON.stringify(input.run) !== JSON.stringify(previous.run ?? null)) ||
    (input.headers !== undefined && JSON.stringify(input.headers) !== JSON.stringify(previous.headers ?? [])) ||
    (input.query !== undefined && JSON.stringify(input.query) !== JSON.stringify(previous.query ?? [])) ||
    (input.credentials !== undefined && JSON.stringify(input.credentials) !== JSON.stringify(previous.credentials ?? {})) ||
    (!hasMcpDefaultCredentialSlot(previous) && Boolean(input.credential))
  if (changed) throw new BusinessRuleError('invalid', 'MCP market connection settings are maintained by the platform.', 'mcp-catalog-locked')
}

export interface McpCatalogSnapshot {
  readonly presets: readonly McpPreset[]
  readonly source: import('./admin-contract.js').CommunitySuiteCatalogSourceView
  readonly galleryTags?: import('./suite-catalog-tags.js').CatalogGalleryTags
}

export function mcpCatalogLoader(source: readonly McpPreset[] | (() => Promise<McpCatalogSnapshot>)): () => Promise<McpCatalogSnapshot> {
  return typeof source === 'function' ? source : async () => ({ presets: source, source: { status: 'ok', address: '' } })
}
