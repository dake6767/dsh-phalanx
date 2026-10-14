import { pluginDeclaration } from './plugin-contribution-checks.js'
import type { CommunityExecutionInput, CommunityExecutionView } from './admin-contract.js'
import type { ContributionDeclaration, ContributionFinding } from './member-contribution.js'
import { BusinessRuleError } from './business-error.js'
import { executionConfiguration } from './execution-configuration.js'

/** Declarations contain names and instructions; credential values belong to administrator configuration. */
export function contributionDeclaration(value: unknown): ContributionDeclaration {
  const invalid = () => new BusinessRuleError('invalid', 'Provide a purpose and value-free execution declaration using valid command and variable names.', 'contribution-invalid')
  if (!value || typeof value !== 'object') throw invalid()
  const input = value as ContributionDeclaration
  if (typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.length > 4096 || Object.keys(input).some(key => !['purpose', 'execution', 'plugin'].includes(key))) throw invalid()
  const plugin = input.plugin === undefined ? {} : { plugin: pluginDeclaration(input.plugin) }
  if (input.execution === undefined) return { purpose: input.purpose.trim(), ...plugin }
  const execution = input.execution
  if (!execution || typeof execution !== 'object' || Object.keys(execution).some(key => !['commands', 'variables', 'prepare'].includes(key)) || !Array.isArray(execution.variables)) throw invalid()
  for (const variable of execution.variables) {
    if (!variable || Object.keys(variable).some(key => !['name', 'purpose', 'application'].includes(key)) || [variable.purpose, variable.application].some(text => typeof text !== 'string' || !text.trim() || text.length > 4096)) throw invalid()
  }
  const checked = executionConfiguration({ enabled: false, commands: execution.commands, variables: execution.variables.map(row => ({ name: row.name, secret: true })), ...(execution.prepare === undefined ? {} : { prepare: execution.prepare }) })
  return { purpose: input.purpose.trim(), ...plugin, execution: { commands: checked.commands, variables: execution.variables.map(row => ({ name: row.name, purpose: row.purpose.trim(), application: row.application.trim() })), ...(checked.prepare ? { prepare: checked.prepare } : {}) } }
}

export function contributionPrefill(declaration: ContributionDeclaration, previous?: CommunityExecutionView): CommunityExecutionInput {
  const execution = declaration.execution, prepare = previous?.prepare ?? declaration.execution?.prepare
  return { enabled: previous?.enabled ?? false,
    commands: [...(previous?.commands ?? []), ...(execution?.commands.filter(row => !previous?.commands.some(old => old.command === row.command)) ?? [])],
    variables: [...(previous?.variables.map(({ name, secret, value }) => ({ name, secret, ...(value === undefined ? {} : { value }) })) ?? []), ...(execution?.variables.filter(row => !previous?.variables.some(old => old.name === row.name)).map(row => ({ name: row.name, secret: true })) ?? [])],
    ...(prepare ? { prepare } : {}) }
}

/** Self-contained functions also run in the member tool before any network upload. */
export function excludedContributionFile(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  return name.startsWith('.env') || /\.(pem|key|p12|pfx|crt|cer)$/iu.test(name)
}
export function scanContributionCredentials(files: readonly { path: string, content: string }[], visibleReferences: ReadonlySet<string> = new Set()): { findings: ContributionFinding[], files: readonly { path: string, content: string }[] } {
  const findings: ContributionFinding[] = [], redacted: { path: string, content: string }[] = []
  for (const file of files) {
    let content = file.content, json = false
    try { JSON.parse(file.content); json = true } catch { /* Source files and Markdown are not JSON. */ }
    const add = (code: ContributionFinding['code'], severity: 'reject' | 'warning') => {
      if (!findings.some(row => row.path === file.path && row.code === code)) findings.push({ code, severity, path: file.path, advice: 'Remove the credential from this file and read a named secret variable from the contribution declaration. Do not include its value in a declaration or message.' })
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/u.test(file.content)) { add('contribution-private-key', 'reject'); content = content.replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gu, '[redacted private key]') }
    // Known credential prefixes are rejected even without a recognizable assignment.
    if (/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/u.test(file.content)) { add('contribution-credential-high', 'reject'); content = content.replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/gu, '[redacted]') }
    for (const match of file.content.matchAll(/(?:["']?\b[A-Za-z_][A-Za-z0-9_-]*(?:key|token|secret|password)[A-Za-z0-9_-]*["']?|["']?\b(?:key|token|secret|password)\b["']?)\s*(?:=|:)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9_./+=-]{4,}))/giu)) {
      if (json && match[3] && /^(?:true|false|null|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/iu.test(match[3])) continue
      const value = match[1] ?? match[2] ?? match[3]!
      if (/^(?:(?:example|fixture|test|dummy)(?:[-_](?:key|token|secret|password))?|placeholder|your[-_ ][a-z_ -]+|changeme|\$\{[^}]+\}|\{access-token\}|process\.env\.[A-Z_]+)$/iu.test(value)) continue
      const counts = new Map<string, number>(); for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
      const entropy = [...counts.values()].reduce((sum, count) => { const frequency = count / value.length; return sum - frequency * Math.log2(frequency) }, 0)
      const high = value.length >= 20 && entropy >= 3.5
      // Review drafts may retain already-public variable names. Finding severity
      // is unchanged, and high-confidence values are always hidden.
      if (high || !visibleReferences.has(value)) content = json
        ? content.replace(/"(?:[^"\\]|\\.)*"/gu, text => text.split(value).join('[redacted]'))
        : content.split(value).join('[redacted]')
      add(high ? 'contribution-credential-high' : 'contribution-credential-low', high ? 'reject' : 'warning')
    }
    redacted.push({ path: file.path, content })
  }
  return { findings, files: redacted }
}

export function inspectContributionCredentials(files: readonly { path: string, content: string }[]): ContributionFinding[] { return scanContributionCredentials(files).findings }
export function redactContributionContent(content: string, visibleReferences: ReadonlySet<string> = new Set()): string { return scanContributionCredentials([{ path: 'content', content }], visibleReferences).files[0]!.content }
export function contributionDeclarationTexts(value: unknown, path = 'declaration'): { path: string, content: string }[] {
  if (typeof value === 'string') return [{ path, content: value }]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) => contributionDeclarationTexts(item, `${path}.${key}`))
}
export function redactContributionDeclaration<T>(value: T, visibleReferences: ReadonlySet<string> = new Set()): T {
  if (typeof value === 'string') return redactContributionContent(value, visibleReferences) as T
  if (Array.isArray(value)) return value.map(item => redactContributionDeclaration(item, visibleReferences)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactContributionDeclaration(item, visibleReferences)])) as T
  return value
}
