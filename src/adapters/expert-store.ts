import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertExpertInput, type ExpertState } from '../domain/expert.js'
import type { ExpertStorePort } from '../ports/experts.js'

/** Platform-owned expert definitions survive member environment resets. */
export class FileExpertStore implements ExpertStorePort {
  private commitVersion = 0
  version(): number { return this.commitVersion }
  private state: ExpertState = { revision: 0, experts: [], grants: {}, selections: {} }
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const stored = JSON.parse(readFileSync(path, 'utf8')) as ExpertState & { schema?: number }
    if (stored.schema !== 1) throw new Error('Invalid expert storage schema')
    this.validate(stored); this.state = stored; chmodSync(path, 0o600)
  }
  read(): ExpertState { return structuredClone(this.state) }
  write(state: ExpertState): void {
    this.validate(state)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ ...state, schema: 1 }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path); this.state = structuredClone(state); this.commitVersion++
    } finally { rmSync(temporary, { force: true }) }
  }
  private validate(state: ExpertState) {
    const identity = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(value)
    const assignment = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([id, names]) => identity(id) && Array.isArray(names) && names.every(identity))
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.experts) || !assignment(state.grants) || !assignment(state.selections)) throw new Error('Invalid expert storage')
    const ids = new Set<string>()
    for (const row of state.experts) {
      assertExpertInput(row)
      if (!identity(row.id) || ids.has(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.published !== 'boolean'
        || !Array.isArray(row.plugins) || row.plugins.some((name: unknown) => typeof name !== 'string') || !Array.isArray(row.mcp) || row.mcp.some((name: unknown) => typeof name !== 'string')
        || row.model !== null && (!row.model || typeof row.model.providerId !== 'string' || typeof row.model.name !== 'string')
        || !Array.isArray(row.examples) || row.examples.some((value: unknown) => typeof value !== 'string')) throw new Error('Invalid expert record')
      ids.add(row.id)
    }
  }
}
