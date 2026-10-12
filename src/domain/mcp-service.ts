import type { CommunityMcpService } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'

export interface McpService extends CommunityMcpService { readonly generation: number }
export interface McpState {
  readonly services: readonly McpService[]
  readonly grants: Readonly<Record<string, readonly string[]>>
}
export function validateMcpService(value: CommunityMcpService): void {
  const invalid = () => new BusinessRuleError('invalid', 'Use a p- prefixed name of 3–32 letters, digits, underscores or hyphens and an HTTP address.', 'mcp-service-invalid')
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !/^p-[A-Za-z0-9_-]{1,30}$/u.test(value.name)
    || typeof value.description !== 'string' || value.description.length > 4000 || typeof value.url !== 'string') throw invalid()
  let url: URL
  try { url = new URL(value.url) } catch { throw invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw invalid()
}
