import { createHash } from 'node:crypto'
import { skillImportMetadata } from '../dsh/skill-format.js'
import { SkillArchiveError, SKILL_MAX_BYTES } from '../domain/skill-library.js'
import { SKILL_IMPORT_MAX_BYTES, type SkillImportWarning, type SkillImportSuggestion } from '../domain/skill-import.js'
import { readSkillZip } from './skill-archive.js'

export interface SkillImportFile { readonly path: string, readonly bytes: Buffer }
export interface DiscoveredSkill {
  readonly name: string
  readonly description: string
  readonly markdown: string
  readonly path: string
  readonly hash: string
  readonly files: readonly SkillImportFile[]
  readonly internal: boolean
  readonly orchestration: boolean
  readonly warnings: readonly SkillImportWarning[]
}
const invalid = (reason: string) => new SkillArchiveError('skill-archive-invalid', reason)
const skipped = new Set(['node_modules', '.git', 'dist', 'build'])
const containers = ['skills', '.agents/skills', '.claude/skills', '.cursor/skills', '.codex/skills', '.github/skills']

/** ZIP and repository transports share a deterministic, non-executing discovery policy. */
export async function inspectSkillImport(bytes: Buffer, bundled: readonly string[]) {
  if (bytes.length > SKILL_IMPORT_MAX_BYTES) throw new SkillArchiveError('skill-upload-too-large', 'The import must be at most 100 MB.')
  let files: readonly SkillImportFile[]
  try { files = await readSkillZip(bytes, SKILL_IMPORT_MAX_BYTES) }
  catch (error) { if (error instanceof SkillArchiveError) throw error; throw invalid('The ZIP is corrupt, encrypted, or contains an unsafe path.') }
  const first = files[0]?.path.split('/')[0]
  // Download archives often add one wrapper around the repository or single skill.
  if (first && files.every(file => file.path.startsWith(first + '/')) && !containers.includes(first)) files = files.map(file => ({ ...file, path: file.path.slice(first.length + 1) }))
  return discoverSkillFiles(files, bundled)
}
export function discoverSkillFiles(files: readonly SkillImportFile[], bundled: readonly string[], allowEmpty = false, links: readonly string[] = []): { candidates: readonly DiscoveredSkill[], packs: readonly SkillImportSuggestion[] } {
  const roots = [...files.map(file => file.path), ...links].filter(path => path.split('/').at(-1) === 'SKILL.md').map(path => path.slice(0, -'SKILL.md'.length))
  let selected = roots.includes('') ? [''] : roots.filter(root => containers.some(container => root.startsWith(container + '/') && root.slice(container.length + 1).split('/').filter(Boolean).length <= 3) && !root.split('/').some(part => skipped.has(part)))
  if (!selected.length) selected = roots.filter(root => root.split('/').filter(Boolean).length <= 5 && !root.split('/').some(part => skipped.has(part)))
  const seen = new Set<string>(), candidates: DiscoveredSkill[] = []
  for (const prefix of selected.sort()) {
    if (links.some(path => path.startsWith(prefix))) throw invalid('Links and special files are not allowed in imported repositories.')
    const entry = files.find(file => file.path === prefix + 'SKILL.md')!
    let markdown: string
    try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes) } catch { throw invalid('SKILL.md must use UTF-8 text.') }
    const meta = skillImportMetadata(markdown)
    if (seen.has(meta.name)) continue
    if (bundled.includes(meta.name)) throw new SkillArchiveError('skill-builtin-conflict', 'Rename this skill: its name belongs to a bundled runtime skill.')
    seen.add(meta.name)
    const contents = files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) })).sort((a, b) => a.path.localeCompare(b.path, 'en'))
    if (contents.reduce((size, file) => size + file.bytes.length, 0) > SKILL_MAX_BYTES) throw new SkillArchiveError('skill-upload-too-large', 'The extracted skill must be at most 20 MB.')
    const hash = createHash('sha256')
    for (const file of contents) hash.update(file.path).update('\0').update(String(file.bytes.length)).update('\0').update(file.bytes)
    candidates.push({ ...meta, markdown, path: prefix.replace(/\/$/u, ''), files: contents, hash: hash.digest('hex'), warnings: warnings(contents) })
  }
  if (!candidates.length && !allowEmpty) throw invalid('No skills were found in this source.')
  return { candidates, packs: suggestedPacks(files, candidates) }
}
function warnings(files: readonly SkillImportFile[]): readonly SkillImportWarning[] {
  const result: SkillImportWarning[] = []
  for (const file of files) {
    if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/iu.test(file.path)) result.push({ path: file.path, kind: 'filename' })
    const text = file.bytes.toString('utf8')
    const privateKey = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(text)
    const tokens = text.matchAll(/(?:key|token|secret|password)\s*[:=]\s*["']?([a-zA-Z0-9_+/-]{24,})/giu)
    const entropy = [...tokens].some(match => { const value = match[1]!, counts = new Map<string, number>(); for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1); return [...counts.values()].reduce((sum, count) => { const p = count / value.length; return sum - p * Math.log2(p) }, 0) >= 4 })
    if (privateKey || entropy) result.push({ path: file.path, kind: 'content' })
  }
  return result
}
function suggestedPacks(files: readonly SkillImportFile[], candidates: readonly DiscoveredSkill[]): readonly SkillImportSuggestion[] {
  const packs: SkillImportSuggestion[] = []
  for (const path of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    const file = files.find(file => file.path === path)
    if (!file) continue
    let data: unknown
    try { data = JSON.parse(file.bytes.toString('utf8')) } catch { continue }
    if (!data || typeof data !== 'object') continue
    const root = data as Record<string, unknown>, entries = path.endsWith('/marketplace.json') ? root.plugins : [root]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name) || !Array.isArray(entry.skills)) continue
      const paths = entry.skills.filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.replace(/^\.\//u, '').replace(/\/$/u, ''))
      if (paths.some((value: string) => !value || value.startsWith('/') || value.includes('\\') || value.split('/').some(part => part === '..' || part === '.'))) continue
      const skills = candidates.filter(skill => paths.includes(skill.path)).map(skill => skill.name)
      if (skills.length && !packs.some(pack => pack.name === entry.name)) packs.push({ name: entry.name, description: typeof entry.description === 'string' ? entry.description : entry.name, skills })
    }
  }
  return packs
}
