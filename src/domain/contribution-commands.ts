import { executionSuggestions } from './execution-suggestions.js'
import type { ContributionDeclaration, ContributionFinding } from './member-contribution.js'

/** Advisory static scan: inspect scripts and documented shell invocations without executing contributed code. */
export function contributionCommandFindings(files: ReadonlyMap<string, string>, declaration: ContributionDeclaration | undefined, supplied: readonly string[]): ContributionFinding[] {
  const known = new Set([...supplied, ...declaration?.requiredCommands?.map(row => row.name) ?? []])
  const findings: ContributionFinding[] = []
  for (const [path, content] of files) {
    const candidates = new Set(executionSuggestions(new Map([[path, content]])).commands)
    if (/\.(?:sh|bash)$/u.test(path) || /^#!.*\b(?:sh|bash)\b/u.test(content)) for (const name of shellCommands(content)) candidates.add(name)
    if (path === 'SKILL.md') {
      for (const block of content.matchAll(/```(?:sh|bash|shell|console)\s*\n([\s\S]*?)```/gu)) {
        for (const command of shellCommands(block[1]!.replace(/^\s*\$ /gmu, ''))) if (!command.includes('/')) candidates.add(command)
      }
      for (const inline of content.matchAll(/`([A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\s+[^`\n]+)?`/gu)) if (inline[1]!.includes('-') || /\s/u.test(inline[0])) candidates.add(inline[1]!)
    }
    for (const command of candidates) if (!command.includes('/') && !known.has(command)) findings.push({ code: 'contribution-command-undeclared', severity: 'warning', path, advice: `Declare required command ${command} with its purpose and installation instructions, or remove the invocation. It is not supplied by the instance image.` })
  }
  return findings
}

/** Split explicit shell command boundaries while leaving quoted argument text intact. */
function shellCommands(content: string): readonly string[] {
  let quote = '', escaped = false, current = ''
  const commands: string[] = []
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\' && quote !== "'") { current += character; escaped = true; continue }
    if (quote) { current += character; if (character === quote) quote = ''; continue }
    if (character === '"' || character === "'") { current += character; quote = character; continue }
    if (character === '&' && (/[<>]/u.test(content[index - 1] ?? '') || content[index + 1] === '>')) { current += character; continue }
    if (';|&\n'.includes(character)) { commands.push(current); current = '' } else current += character
  }
  commands.push(current)
  return executionSuggestions(new Map([['documented.sh', commands.join('\n')]])).commands.filter(name => !name.includes('/'))
}
