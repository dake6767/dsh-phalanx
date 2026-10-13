import type { CommunityMcpCatalogEntry, CommunityMcpCatalogInput, CommunityMcpInput } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'

/** Versioned platform presets; installed services retain their adopted configuration. */
export const mcpCatalog: readonly CommunityMcpCatalogEntry[] = [{ id: 'amap', version: '1', title: { en: 'Amap', 'zh-CN': '高德地图' }, description: { en: 'Maps, routes and weather', 'zh-CN': '地点搜索、路线规划与天气查询' }, location: 'remote', credentialLabel: { en: 'Amap Web Service Key', 'zh-CN': '高德 Web 服务 Key' }, documentation: 'https://lbs.amap.com/api/mcp-server/gettingstarted', imported: 0 }]
export function catalogInput(input: CommunityMcpCatalogInput): CommunityMcpInput {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['presetId', 'name', 'credential', 'requestId'].includes(key))
    || input.presetId !== 'amap' || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.requestId)
    || typeof input.credential !== 'string' || !input.credential.trim()) throw new BusinessRuleError('invalid', 'Invalid MCP market input.', 'mcp-service-invalid')
  return { name: input.name, description: 'Amap', url: 'https://mcp.amap.com/mcp', run: null, headers: [], query: [{ name: 'key', value: '{credential}' }], credential: input.credential }
}

export function assertCatalogConfiguration(previous: import('./mcp-service.js').McpService, input: CommunityMcpInput): void {
  if (!previous.catalog) return
  const changed = input.url !== previous.url || input.description !== previous.description
    || (input.run !== undefined && JSON.stringify(input.run) !== JSON.stringify(previous.run ?? null))
    || (input.headers !== undefined && JSON.stringify(input.headers) !== JSON.stringify(previous.headers ?? []))
    || (input.query !== undefined && JSON.stringify(input.query) !== JSON.stringify(previous.query ?? []))
    || (input.credentials !== undefined && Object.keys(input.credentials).length > 0)
  if (changed) throw new BusinessRuleError('invalid', 'MCP market connection settings are maintained by the platform.', 'mcp-catalog-locked')
}
