import { parse, stringify } from 'yaml'
import { SkillArchiveError } from '../domain/skill-library.js'

const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
const invalid = (reason: string) => new SkillArchiveError('skill-frontmatter-invalid', reason)
/** Frozen DSH filesystem skill format; public boundary, no runtime implementation imports. */
function frontmatter(markdown: string) {
  const match = header.exec(markdown)
  if (!match) throw invalid('SKILL.md requires a YAML frontmatter block.')
  let data: Record<string, unknown>
  try {
    data = parse(match[1]!, { logLevel: 'silent' }) as Record<string, unknown>
  } catch {
    throw invalid('The YAML frontmatter could not be parsed.')
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw invalid('The YAML frontmatter must be a mapping.')
  return { data, body: markdown.slice(match[0].length) }
}
export function skillMetadata(markdown: string): { name: string; description: string } {
  const { data } = frontmatter(markdown)
  if (typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(data.name))
    throw invalid('The name field must use lowercase letters, digits and single hyphens.')
  if (typeof data.description !== 'string' || !data.description.length) throw invalid('The description field must be a nonempty string.')
  if (['disableModelInvocation', 'modelInvocable', 'userInvocable'].some(key => Object.hasOwn(data, key)))
    throw invalid('Legacy invocation fields are unsupported; use disable-model-invocation and user-invocable.')
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (!Object.hasOwn(data, key)) continue
    const value = data[key]
    if (typeof value === 'boolean' || value === 0 || value === 1 || (typeof value === 'string' && /^(true|false|yes|no|on|off|0|1)$/iu.test(value))) continue
    throw invalid(key === 'user-invocable' ? 'Invalid boolean value for user-invocable.' : 'Invalid boolean value for disable-model-invocation.')
  }
  return { name: data.name, description: data.description }
}

/** Generated orchestration uses the same official frontmatter contract as uploaded skills. */
export function orchestrationSkillMarkdown(name: string, description: string, instructions: string): string {
  if (!header.test(instructions)) return `---\n${stringify({ name, description })}---\n\n${instructions}\n`
  skillMetadata(instructions)
  const { data, body } = frontmatter(instructions)
  return `---\n${stringify({ ...data, name, description })}---\n${body}`
}

/** Discovery hints belong to the skill format, independent of its ZIP/Git transport. */
export function skillImportMetadata(markdown: string) {
  const metadata = skillMetadata(markdown),
    { data } = frontmatter(markdown)
  const hints = data.metadata as { internal?: unknown } | undefined,
    orchestration = data.orchestration as { children?: unknown } | undefined
  return { ...metadata, internal: hints?.internal === true, orchestration: Array.isArray(orchestration?.children) && orchestration.children.length > 0 }
}
