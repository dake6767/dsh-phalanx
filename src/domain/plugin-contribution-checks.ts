import type { CommunityPluginUpstreamInput } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'
import type { ContributionFinding } from './member-contribution.js'
import type { PreparedPlugin } from './plugin-library.js'
import { upstreamInput } from './plugin-upstream.js'
import { pluginAccessConfiguration, pluginAccessReferences, type PluginEntryConfig } from './plugin-access.js'

export interface PluginContributionDeclaration {
  readonly upstreams: readonly (Omit<CommunityPluginUpstreamInput, 'credential'> & { readonly directReason?: string })[]
  readonly environment: readonly { readonly name: string, readonly secret: boolean, readonly purpose: string, readonly application: string, readonly reference?: string }[]
  readonly entriesYaml: string
}
export interface ContributionPluginSyntax { parse(source: string): Readonly<Record<string, PluginEntryConfig>>, entryIds(plugin: PreparedPlugin): readonly string[] }
export function pluginDeclaration(value: unknown): PluginContributionDeclaration {
  const invalid = () => new BusinessRuleError('invalid', 'Declare plugin upstreams, environment names and configuration references without credential values.', 'contribution-invalid')
  if (!value || typeof value !== 'object') throw invalid()
  const input = value as PluginContributionDeclaration
  if (Object.keys(input).some(key => !['upstreams', 'environment', 'entriesYaml'].includes(key)) || !Array.isArray(input.upstreams) || input.upstreams.length > 128 || !Array.isArray(input.environment) || input.environment.length > 128 || typeof input.entriesYaml !== 'string' || input.entriesYaml.length > 64 * 1024) throw invalid()
  const names = new Set<string>()
  for (const upstream of input.upstreams) {
    if (!upstream || Object.keys(upstream).some(key => !['name', 'baseUrl', 'headers', 'testRequest', 'directReason'].includes(key)) || upstream.directReason !== undefined && (typeof upstream.directReason !== 'string' || !upstream.directReason.trim() || upstream.directReason.length > 4096)) throw invalid()
    upstreamInput(upstream)
    if (names.has(upstream.name)) throw invalid()
    names.add(upstream.name)
  }
  for (const variable of input.environment) {
    if (!variable || Object.keys(variable).some(key => !['name', 'secret', 'purpose', 'application', 'reference'].includes(key)) || typeof variable.name !== 'string' || typeof variable.secret !== 'boolean' || [variable.purpose, variable.application].some(text => typeof text !== 'string' || !text.trim() || text.length > 4096)
      || variable.reference !== undefined && (typeof variable.reference !== 'string' || !/^\{(?:access-token|upstream:[a-zA-Z0-9_-]{1,64})\}$/u.test(variable.reference))) throw invalid()
  }
  return { upstreams: input.upstreams.map(row => ({ ...row })), environment: input.environment.map(row => ({ ...row })), entriesYaml: input.entriesYaml }
}
export function pluginContributionAccess(declaration: PluginContributionDeclaration) {
  return { environment: declaration.environment.map(row => ({ name: row.name, value: row.reference ?? (row.secret ? '{access-token}' : '') })), entriesYaml: declaration.entriesYaml }
}
export function pluginContributionFindings(declaration: PluginContributionDeclaration, plugin: PreparedPlugin, syntax: ContributionPluginSyntax, occupied: ReadonlySet<string> = new Set()): ContributionFinding[] {
  const findings: ContributionFinding[] = [], input = pluginContributionAccess(declaration)
  try {
    const checked = pluginAccessConfiguration(input, source => syntax.parse(source), syntax.entryIds(plugin), occupied, new Set(declaration.upstreams.map(row => row.name)))
    const references = pluginAccessReferences(checked)
    for (const upstream of declaration.upstreams) if (!references.some(row => row.name === upstream.name)) findings.push({ code: 'contribution-plugin-upstream-unused', severity: upstream.directReason ? 'warning' : 'reject', path: `declaration.plugin.upstreams.${upstream.name}`, advice: `Point an environment or entry setting at {upstream:${upstream.name}} instead of hard-coding the third-party address; explain a credential-free direct connection if it is intentional.` })
  } catch (error) {
    if (!(error instanceof BusinessRuleError)) throw error
    const reason = error.params?.reason
    const code = reason === 'reserved' ? 'contribution-plugin-reserved' : reason === 'entry' ? 'contribution-plugin-entry' : reason === 'upstream' ? 'contribution-plugin-reference' : 'contribution-plugin-access'
    findings.push({ code, severity: 'reject', path: 'declaration.plugin', advice: reason === 'reserved' ? 'Choose a plugin-specific variable name; platform startup variables are reserved.' : reason === 'entry' ? 'Use an entry ID declared by the bundle patch.' : reason === 'upstream' ? 'Declare every upstream used by {upstream:name} references.' : 'Use valid, unique environment names and literal entry YAML under the administrator access rules.' })
  }
  return findings
}

export function pluginContributionPrefill(declaration: PluginContributionDeclaration, syntax: ContributionPluginSyntax, previous?: import('./admin-contract.js').CommunityPluginAccessView, upstreams: readonly import('./admin-contract.js').CommunityPluginUpstreamView[] = []) {
  const declared = pluginContributionAccess(declaration), currentEntries = syntax.parse(previous?.entriesYaml ?? ''), newEntries = syntax.parse(declared.entriesYaml)
  const merge = (before: Readonly<Record<string, unknown>>, added: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
    const values = new Map(Object.entries(before))
    for (const [name, value] of Object.entries(added)) {
      const old = values.get(name)
      if (!values.has(name)) values.set(name, value)
      else if (old && value && typeof old === 'object' && typeof value === 'object' && !Array.isArray(old) && !Array.isArray(value)) values.set(name, merge(old as Readonly<Record<string, unknown>>, value as Readonly<Record<string, unknown>>))
    }
    return Object.fromEntries(values)
  }
  const entries = merge(currentEntries, newEntries)
  return {
    access: { environment: [...previous?.environment ?? [], ...declared.environment.filter(row => !previous?.environment.some(old => old.name === row.name))], entriesYaml: JSON.stringify(entries, null, 2) },
    upstreams: [...upstreams, ...declaration.upstreams.filter(row => !upstreams.some(old => old.name === row.name)).map(({ name, baseUrl, headers, testRequest }) => ({ name, baseUrl, headers, ...(testRequest ? { testRequest } : {}), hasCredential: false }))],
    removed: { environment: previous?.environment.filter(row => !declaration.environment.some(next => next.name === row.name)).map(row => row.name) ?? [], entries: Object.keys(currentEntries).filter(name => !Object.hasOwn(newEntries, name)), upstreams: upstreams.filter(row => !declaration.upstreams.some(next => next.name === row.name)).map(row => row.name) },
  }
}
