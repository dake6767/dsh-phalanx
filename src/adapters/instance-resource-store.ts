import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BusinessRuleError } from '../domain/business-error.js'
import { instanceIdleSeconds, instanceResourceLimits, type InstanceResourceLimits, type InstanceResourceState } from '../domain/instance-resources.js'
import type { InstanceResourceStorePort } from '../ports/instance-resources.js'

/** Atomic private settings; deployment input is read only when the file is absent. */
export class FileInstanceResourceStore implements InstanceResourceStorePort {
  private state: InstanceResourceState
  constructor(private readonly path: string, initial: () => InstanceResourceLimits, initialIdleSeconds = 1800) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let source: string | undefined
    try { source = readFileSync(path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const input = source === undefined ? { revision: 0, defaults: initial(), overrides: {} } : JSON.parse(source)
    this.state = normalize(input, initialIdleSeconds)
    if (source === undefined || input.idleSeconds === undefined || input.residents === undefined) this.write(this.state)
    else chmodSync(path, 0o600)
  }
  read(): InstanceResourceState { return this.state }
  save(state: InstanceResourceState): void {
    if (state.revision !== this.state.revision + 1) throw new BusinessRuleError('conflict', 'Instance resource settings changed. Reload before saving or applying.', 'instance-resource-revision-conflict')
    const next = normalize(state)
    this.write(next)
    this.state = next
  }
  private write(state: InstanceResourceState): void {
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path) }
    finally { rmSync(temporary, { force: true }) }
  }
}
function normalize(input: InstanceResourceState, initialIdleSeconds?: number): InstanceResourceState {
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0 || !input.overrides || typeof input.overrides !== 'object' || Array.isArray(input.overrides)) throw new Error('Invalid instance resource settings')
  const idleSeconds = instanceIdleSeconds(input.idleSeconds === undefined ? initialIdleSeconds : input.idleSeconds)
  const rawResidents = input.residents === undefined && initialIdleSeconds !== undefined ? {} : input.residents
  if (!rawResidents || typeof rawResidents !== 'object' || Array.isArray(rawResidents)) throw new Error('Invalid resident instance settings')
  const residents = Object.fromEntries(Object.entries(rawResidents).map(([spaceId, enabled]) => {
    if (!/^[a-f0-9]{32}$/u.test(spaceId) || enabled !== true) throw new Error('Invalid resident instance identity')
    return [spaceId, true as const]
  }))
  const overrides = Object.fromEntries(Object.entries(input.overrides).map(([spaceId, limits]) => {
    if (!/^[a-f0-9]{32}$/u.test(spaceId)) throw new Error('Invalid instance resource space identity')
    return [spaceId, Object.freeze(instanceResourceLimits(limits))]
  }))
  return Object.freeze({ idleSeconds, residents: Object.freeze(residents), revision: input.revision, defaults: Object.freeze(instanceResourceLimits(input.defaults)), overrides: Object.freeze(overrides) })
}
