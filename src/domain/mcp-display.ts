import type { McpService } from './mcp-service.js'
import type { CommunityMcpDisplay, CommunityMcpService, CommunityMcpInput } from './mcp-admin-contract.js'
import { BusinessRuleError } from './business-error.js'

/** Presentation never supplies runtime names, paths or authorization keys. */
export function mcpDisplayText(service: Pick<CommunityMcpService, 'name' | 'description' | 'display'>, locale: 'en' | 'zh-CN') {
  return {
    name: service.display?.name ?? service.display?.defaults?.name[locale] ?? service.name,
    description: service.display?.description ?? service.display?.defaults?.description[locale] ?? service.description,
  }
}
export function mergeMcpDisplay(
  input: Pick<CommunityMcpDisplay, 'name' | 'description'> | undefined,
  previous?: CommunityMcpDisplay,
): CommunityMcpDisplay | undefined {
  if (input === undefined) return previous
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'name' && key !== 'description'))
    throw new BusinessRuleError('invalid', 'Invalid MCP display information.', 'mcp-display-invalid')
  return { ...previous, ...input }
}
export function validateMcpDisplay(value: CommunityMcpDisplay | undefined): void {
  if (value === undefined) return
  const text = (value: unknown, maximum: number, required = false) =>
    typeof value === 'string' && value.length <= maximum && (!required || Boolean(value.trim()))
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.name !== undefined && !text(value.name, 200, true)) ||
    (value.description !== undefined && !text(value.description, 4000)) ||
    (value.defaults !== undefined &&
      (!value.defaults ||
        ['en', 'zh-CN'].some(
          locale => !text(value.defaults?.name?.[locale as 'en' | 'zh-CN'], 200, true) || !text(value.defaults?.description?.[locale as 'en' | 'zh-CN'], 4000),
        )))
  )
    throw new BusinessRuleError('invalid', 'Invalid MCP display information.', 'mcp-display-invalid')
}

/** A display-only edit preserves the current runtime and any in-flight catalog intent. */
export function mcpDisplayUpdate(previous: McpService | undefined, input: CommunityMcpInput, connectionChanged: boolean): McpService | undefined {
  if (
    !previous ||
    !input.display ||
    connectionChanged ||
    input.name !== previous.name ||
    input.description !== previous.description ||
    (input.required ?? previous.required ?? false) !== (previous.required ?? false) ||
    JSON.stringify(input.disabledTools ?? previous.disabledTools ?? []) !== JSON.stringify(previous.disabledTools ?? [])
  )
    return undefined
  return { ...previous, display: input.display }
}
