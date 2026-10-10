import { parse } from 'yaml'
import { SkillArchiveError } from '../domain/skill-library.js'

const invalid = (reason: string) => new SkillArchiveError('skill-frontmatter-invalid', reason)
/** Frozen DSH filesystem skill format; public boundary, no runtime implementation imports. */
export function skillMetadata(markdown: string): { name: string, description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)
  if (!match) throw invalid('SKILL.md requires a YAML frontmatter block.')
  let data: Record<string, unknown>
  try { data = parse(match[1]!) as Record<string, unknown> } catch { throw invalid('The YAML frontmatter could not be parsed.') }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw invalid('The YAML frontmatter must be a mapping.')
  if (typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(data.name)) throw invalid('The name field must use lowercase letters, digits and single hyphens.')
  if (typeof data.description !== 'string' || !data.description.length) throw invalid('The description field must be a nonempty string.')
  if (['disableModelInvocation', 'modelInvocable', 'userInvocable'].some(key => Object.hasOwn(data, key))) throw invalid('Legacy invocation fields are unsupported; use disable-model-invocation and user-invocable.')
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (!Object.hasOwn(data, key)) continue
    const value = data[key]
    if (typeof value === 'boolean' || value === 0 || value === 1 || (typeof value === 'string' && /^(true|false|yes|no|on|off|0|1)$/iu.test(value))) continue
    throw invalid(key === 'user-invocable' ? 'Invalid boolean value for user-invocable.' : 'Invalid boolean value for disable-model-invocation.')
  }
  return { name: data.name, description: data.description }
}
