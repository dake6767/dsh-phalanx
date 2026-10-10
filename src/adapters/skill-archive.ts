import { fromBuffer, type Entry, type ZipFile } from 'yauzl'
import type { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'
import { skillMetadata } from '../dsh/skill-format.js'
import { SKILL_MAX_BYTES, SkillArchiveError } from '../domain/skill-library.js'

export interface InspectedSkillArchive {
  readonly name: string
  readonly description: string
  readonly markdown: string
  readonly files: readonly { path: string, bytes: Buffer }[]
}
const invalid = (reason: string) => new SkillArchiveError('skill-archive-invalid', reason)
/** Bounded, in-process inspection; all entries are validated before any file is written. */
export async function inspectSkillArchive(bytes: Buffer, bundled: readonly string[]): Promise<InspectedSkillArchive> {
  if (bytes.length > SKILL_MAX_BYTES) throw new SkillArchiveError('skill-upload-too-large', 'The compressed and extracted skill must each be at most 20 MB.')
  try {
    const inspected = await inspect(bytes)
    if (bundled.includes(inspected.name)) throw new SkillArchiveError('skill-builtin-conflict', 'Rename this skill: its name belongs to a bundled runtime skill.')
    return inspected
  }
  catch (error) {
    if (error instanceof SkillArchiveError) throw error
    throw invalid('The ZIP is corrupt, encrypted, or contains an unsafe path.')
  }
}
async function inspect(bytes: Buffer): Promise<InspectedSkillArchive> {
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)))
  const files: { path: string, bytes: Buffer }[] = []
  const paths = new Map<string, boolean>(); let size = 0
  await new Promise<void>((resolve, reject) => {
    let failed = false
    const fail = (error: unknown) => { failed = true; reject(error) }
    zip.on('error', fail); zip.on('end', resolve)
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        if (failed) return
        const directory = entry.fileName.endsWith('/'); const path = directory ? entry.fileName.slice(0, -1) : entry.fileName
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (mode && mode !== (directory ? 0o040000 : 0o100000)) throw invalid('Links and special files are not allowed in skills.')
        if (!path || path.length > 1024 || (/[\\:]/u.test(path) || [...path].some(char => char.charCodeAt(0) < 32)) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw invalid('ZIP entries must stay inside the skill directory.')
        const key = path.toLowerCase()
        if (paths.has(key)) throw invalid('ZIP entries must not repeat or differ only by letter case.')
        paths.set(key, directory)
        if (paths.size > 10000) throw invalid('The skill contains too many files.')
        if (!directory) {
          if (size + entry.uncompressedSize > SKILL_MAX_BYTES) throw new SkillArchiveError('skill-upload-too-large', 'The extracted skill must be at most 20 MB.')
          const stream = await new Promise<Readable>((done, failStream) => zip.openReadStream(entry, (error, value) => error ? failStream(error) : done(value)))
          const chunks: Buffer[] = []
          try {
            for await (const chunk of stream) {
              const part = Buffer.from(chunk as Uint8Array); size += part.length
              if (size > SKILL_MAX_BYTES) throw new SkillArchiveError('skill-upload-too-large', 'The extracted skill must be at most 20 MB.')
              chunks.push(part)
            }
          } finally { stream.destroy() }
          const content = Buffer.concat(chunks)
          if (crc32(content) !== entry.crc32) throw invalid('A ZIP entry failed its checksum.')
          files.push({ path, bytes: content })
        }
        if (!failed) zip.readEntry()
      })().catch(fail)
    })
    zip.readEntry()
  })
  for (const path of paths.keys()) {
    const parts = path.split('/'); parts.pop()
    while (parts.length) { if (paths.get(parts.join('/')) === false) throw invalid('A ZIP file conflicts with a directory.'); parts.pop() }
  }
  const skills = files.filter(file => file.path.split('/').at(-1) === 'SKILL.md')
  const skill = skills[0]
  if (skills.length !== 1 || !skill || skill.path.split('/').length > 2) throw invalid('Include exactly one SKILL.md at the root or in one top-level directory.')
  const prefix = skill.path.slice(0, -'SKILL.md'.length)
  if (prefix && [...paths.keys()].some(path => path !== prefix.slice(0, -1).toLowerCase() && !path.startsWith(prefix.toLowerCase()))) throw invalid('All files must belong to the single top-level skill directory.')
  let markdown: string
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(skill.bytes) }
  catch { throw invalid('SKILL.md must use UTF-8 text.') }
  return { ...skillMetadata(markdown), markdown, files: files.map(file => ({ ...file, path: file.path.slice(prefix.length) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
}
