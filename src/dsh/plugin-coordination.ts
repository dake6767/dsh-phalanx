import type { Document } from 'yaml'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { PluginYieldEntry, SelfInstalledPlugin } from '../ports/managed-plugins.js'

const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }
const marker = ' phalanx-managed-yield:'
const identity = (id: string, name: string) => marker + JSON.stringify([id, name])
const sequence = (source: string) => {
  const document: Document = parseDocument(source, yamlOptions)
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Plugin patch must be a valid sequence')
  return document
}
/** Official package/profile declarations, read without evaluating lazy configuration. */
export function selectedProfileBundles(source: string): readonly string[] {
  const manifest = JSON.parse(source) as { dsh?: { profile?: { bundles?: unknown } } }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) throw new Error('Invalid profile bundles')
  return bundles
}
export function selfBundlePatchFiles(source: string): readonly string[] {
  const manifest = JSON.parse(source) as { dsh?: { bundle?: { patch?: unknown } } }
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) return []
  const files = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) throw new Error('Invalid bundle patches')
  return files
}
export function selfBundleEntries(sources: readonly string[]): SelfInstalledPlugin['entries'] {
  const entries: Array<{ id: string, name: string }> = []
  const visit = (rows: unknown) => {
    if (!isSeq(rows)) return
    for (const row of rows.items) {
      if (!isMap(row)) continue
      const id = row.get('id'); const name = row.get('name')
      if (typeof id === 'string' && typeof name === 'string') entries.push({ id, name })
      if (row.get('group') === true) visit(row.get('config'))
    }
  }
  for (const source of sources) {
    const document = sequence(source)
    if (isSeq(document.contents)) for (const row of document.contents.items) if (isMap(row)) visit(row.get('insert'))
  }
  return entries
}
/** Separate appended rows leave the user's original enablement/configuration intact.
 * Native profile writers preserve scalar comments. A changed owned row becomes the
 * member's row: release its marker and retain its explicit settings. */
export function coordinateProfilePatch(source: string, entries: readonly PluginYieldEntry[]): string {
  const document = sequence(source)
  if (!isSeq(document.contents)) throw new Error('Invalid profile patch')
  let changed = false
  document.contents.items = document.contents.items.filter(row => {
    if (!isMap(row)) return true
    const id = row.get('id', true)
    if (!isScalar(id) || !id.comment?.startsWith(marker)) return true
    changed = true
    if (row.items.length === 3 && typeof id.value === 'string' && typeof row.get('name') === 'string' && row.get('disabled') === true && id.comment === identity(id.value, row.get('name') as string)) return false
    delete id.comment
    return true
  })
  for (const entry of entries) {
    const row = document.createNode(entry)
    if (!isMap(row)) throw new Error('Invalid yielding entry')
    const id = row.get('id', true)
    if (isScalar(id)) id.comment = identity(entry.id, entry.name)
    document.contents.add(row); changed = true
  }
  return changed ? document.toString() : source
}
