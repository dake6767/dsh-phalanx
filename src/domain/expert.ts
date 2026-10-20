import { BusinessRuleError } from './business-error.js'

export interface ExpertModelReference { readonly providerId: string, readonly name: string }
export interface ExpertModelChoice extends ExpertModelReference { readonly id: string, readonly label: string }
export interface ExpertInput {
  readonly model?: ExpertModelReference | null
  readonly name: string
  readonly description: string
  readonly icon: string
  readonly persona: string
  readonly skills: readonly string[]
  readonly skillPacks: readonly string[]
  readonly examples?: readonly string[]
  readonly plugins?: readonly string[]
  readonly mcp?: readonly string[]
}
export interface Expert extends ExpertInput {
  readonly id: string
  readonly revision: number
  readonly published: boolean
  readonly plugins: readonly string[]
  readonly mcp: readonly string[]
  readonly model: ExpertModelReference | null
  readonly examples: readonly string[]
}
export interface ExpertState {
  readonly revision: number
  readonly experts: readonly Expert[]
  readonly grants: Readonly<Record<string, readonly string[]>>
  readonly selections: Readonly<Record<string, readonly string[]>>
}
export interface ExpertFailure { readonly id: string, readonly entries: readonly string[] }
export interface ExpertView extends Expert { readonly modelLabel: string | null, readonly modelUnavailable: boolean; readonly failures: readonly { readonly username: string, readonly entries: readonly string[] }[] }
export function assertExpertInput(input: ExpertInput): void {
  const names = (value: unknown) => Array.isArray(value) && value.length <= 128 && value.every(name => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) && new Set(value).size === value.length
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80
    || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 1000
    || typeof input.icon !== 'string' || input.icon.length > 32 || typeof input.persona !== 'string' || !input.persona.trim() || input.persona.length > 32000
    || input.model != null && (typeof input.model !== 'object' || Array.isArray(input.model) || Object.keys(input.model).some(key => !['providerId', 'name'].includes(key)) || typeof input.model.providerId !== 'string' || !input.model.providerId || input.model.providerId.length > 128 || typeof input.model.name !== 'string' || !input.model.name || input.model.name.length > 256)
    || input.examples !== undefined && (!Array.isArray(input.examples) || ![0, 2, 3].includes(input.examples.length) || input.examples.some(example => typeof example !== 'string' || !example.trim() || example.length > 1000))
    || !names(input.skills) || !names(input.skillPacks)
    || input.plugins !== undefined && (!Array.isArray(input.plugins) || input.plugins.length > 128 || new Set(input.plugins).size !== input.plugins.length || input.plugins.some(name => typeof name !== 'string' || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)))
    || input.mcp !== undefined && (!Array.isArray(input.mcp) || input.mcp.length > 128 || new Set(input.mcp).size !== input.mcp.length || input.mcp.some(name => typeof name !== 'string' || !/^p-[A-Za-z0-9_-]{1,30}$/u.test(name)))) throw new BusinessRuleError('invalid', 'Review the expert name, persona and library references.', 'expert-invalid')
}
