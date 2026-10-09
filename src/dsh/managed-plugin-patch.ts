/** Pure conversion of the official patch grammar, also embedded in the isolated worker. */
export function managedPluginPatch(patches: unknown, prefix: string, resolveModule: (name: string) => string) {
  type Row = Record<string, unknown>
  const fail = (): never => { throw new Error('Unsupported managed plugin patch') }
  const object = (value: unknown): Row => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
    return value as Row
  }
  const entries: Row[][] = []
  const overlays: Row[] = []
  const owned = new Map<string, Row>()
  const originalNames = new Map<string, string>()
  const walk = (values: unknown): Row[] => {
    if (!Array.isArray(values)) return fail()
    return values.map(value => {
      const source = object(value)
      if (typeof source.id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(source.id) || owned.has(source.id)
        || typeof source.name !== 'string') return fail()
      const row: Row = { ...source, id: `${prefix}-${source.id}`, name: resolveModule(source.name) }
      owned.set(source.id, row); originalNames.set(source.id, source.name)
      if (source.group) row.config = walk(source.config)
      return row
    })
  }
  if (!Array.isArray(patches)) return fail()
  for (const value of patches) {
    const patch = object(value)
    const id = patch.id
    if (id !== undefined && typeof id !== 'string') return fail()
    const target = typeof id === 'string' ? owned.get(id) : undefined
    if (!target && typeof id === 'string' && id.startsWith('phalanx-')) return fail()
    if (patch.insert !== undefined) {
      if (Object.keys(patch).some(key => key !== 'id' && key !== 'insert')) return fail()
      const rows = walk(patch.insert)
      if (target) {
        if (!target.group || !Array.isArray(target.config)) return fail()
        target.config.push(...rows)
      } else {
        const index = entries.push(rows) - 1
        overlays.push({ ...(id ? { id } : {}), insert: [{ id: `${prefix}-layer-${index}`, name: '@deepseek-ai/cordis-plugin-include', config: { path: `${prefix}-entries-${index}.json` } }] })
      }
    } else {
      if (typeof id !== 'string') return fail()
      const { name, ...overrides } = patch
      if (target) {
        if (name !== undefined && name !== originalNames.get(id)) return fail()
        for (const [key, value] of Object.entries(overrides)) if (key !== 'id') target[key] = key === 'config' && target.group ? walk(value) : value
      } else {
        // Existing core entries may receive configuration; replacing/disabling their implementation is unsupported.
        if (Object.keys(patch).some(key => !['id', 'name', 'config'].includes(key)) || patch.config === undefined) return fail()
        overlays.push(patch)
      }
    }
  }
  if (!entries.length) return fail()
  return { entries, overlays }
}
