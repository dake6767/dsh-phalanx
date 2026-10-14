import { expect, it } from 'vitest'
import { ExecutionPreparation } from '../src/use-cases/execution-preparation.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../src/domain/platform-execution.js'
import type { PreparedExecution, ExecutionPreparationRecord } from '../src/domain/execution-preparation.js'

function setup(options: { delayedAbort?: boolean, collect?: (ids: readonly string[]) => Promise<void> } = {}) {
  let owner: ExecutionOwner = { id: 'skill:news', version: 'v1' }, image = 'image1'
  let config: ExecutionConfiguration = { enabled: true, commands: [{ command: 'news', blocked: [] }], variables: [{ name: 'KEY', value: 'one', secret: true }], prepare: 'prepare' }
  let failWrite = false
  const records = new Map<string, ExecutionPreparationRecord>()
  const jobs: { resolve: (value: PreparedExecution) => void, reject: (error: Error) => void, signal: AbortSignal }[] = []
  const preparation = new ExecutionPreparation({ identities: () => [owner.id], get: () => owner, owns: () => true }, { retain: () => {}, get: () => config, list: () => [{ owner: owner.id, configuration: config }] }, {
    retain: () => {}, list: () => [...records.values()], get: id => records.get(id), save: (id, value) => { if (failWrite) { failWrite = false; throw new Error('ENOSPC') }; records.set(id, value) },
  }, {
    identity: (target, value) => JSON.stringify([target.version, value.prepare, value.variables, image]), recover: async () => {}, collect: options.collect ?? (async () => {}),
    prepare: async (_owner, _configuration, signal) => new Promise((resolve, reject) => {
      jobs.push({ resolve, reject, signal }); if (!options.delayedAbort) signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }),
  }, { now: () => Date.parse('2026-01-01T00:00:00Z') })
  const artifact = (id: string): PreparedExecution => ({ id, version: owner.version, hash: 'hash-' + id, log: 'prepared' })
  return { preparation, jobs, artifact, failNextWrite: () => { failWrite = true }, setVersion: (version: string) => { owner = { ...owner, version } }, setImage: (value: string) => { image = value }, setConfig: (value: Partial<ExecutionConfiguration>) => { config = { ...config, ...value } } }
}

it('coalesces preparation, retains an old artifact while preparing, and fails closed after failure until explicit retry', async () => {
  const s = setup(); const first = s.preparation.synchronize(); const same = s.preparation.synchronize()
  expect(s.jobs).toHaveLength(1); expect(s.preparation.view('skill:news')?.stage).toBe('preparing')
  expect(() => s.preparation.ready('skill:news')).toThrow(expect.objectContaining({ code: 'not-ready' }))
  s.jobs[0]!.resolve(s.artifact('one')); await Promise.all([first, same]); expect(s.preparation.ready('skill:news').id).toBe('one')
  const retry = s.preparation.refresh('skill:news'); expect(s.preparation.ready('skill:news').id).toBe('one')
  s.jobs[1]!.reject(new Error('fixture preparation failed')); await retry
  expect(s.preparation.view('skill:news')?.stage).toBe('failed')
  expect(() => s.preparation.ready('skill:news')).toThrow(expect.objectContaining({ code: 'not-ready' }))
  await s.preparation.synchronize(); expect(s.jobs).toHaveLength(2)
  const recovered = s.preparation.refresh('skill:news'); s.jobs[2]!.resolve(s.artifact('three')); await recovered
  expect(s.preparation.ready('skill:news').id).toBe('three'); await s.preparation.stop()
})

it('automatically replaces dependencies when skill, credentials, command or image changes', async () => {
  const s = setup()
  for (const change of [() => {}, () => s.setVersion('v2'), () => s.setConfig({ variables: [{ name: 'KEY', value: 'two', secret: true }] }), () => s.setConfig({ prepare: 'different' }), () => s.setImage('image2')]) {
    change(); const work = s.preparation.synchronize(); const id = String(s.jobs.length)
    s.jobs.at(-1)!.resolve(s.artifact(id)); await work; expect(s.preparation.ready('skill:news').id).toBe(id)
  }
  expect(s.jobs).toHaveLength(5); await s.preparation.stop()
})

it('cancels superseded preparation and waits for active work on shutdown', async () => {
  const s = setup(); const first = s.preparation.synchronize(); s.setVersion('v2'); const second = s.preparation.synchronize()
  expect(s.jobs[0]!.signal.aborted).toBe(true); s.jobs[1]!.resolve(s.artifact('current')); await Promise.all([first, second])
  expect(s.preparation.ready('skill:news').id).toBe('current')
  const pending = s.preparation.refresh('skill:news'); await s.preparation.stop(); await pending
  expect(s.jobs[2]!.signal.aborted).toBe(true)
})

it('recovers execution after a transient persistence failure and successful explicit preparation', async () => {
  const s = setup(), first = s.preparation.refresh('skill:news')
  s.failNextWrite(); s.jobs[0]!.resolve(s.artifact('first'))
  await expect(first).rejects.toThrow('ENOSPC')
  expect(s.preparation.view('skill:news')).toMatchObject({ stage: 'failed', log: expect.stringContaining('prepare again') })
  expect(() => s.preparation.ready('skill:news')).toThrow(expect.objectContaining({ code: 'internal' }))
  const retry = s.preparation.refresh('skill:news'); s.jobs[1]!.resolve(s.artifact('recovered')); await retry
  expect(s.preparation.ready('skill:news').id).toBe('recovered'); await s.preparation.stop()
})

it('removes deleted owners and credentials while retaining artifacts leased by running executions', async () => {
  let exists = true, usable = true
  const configs = new Map<string, ExecutionConfiguration>([['skill:news', { enabled: true, commands: [{ command: 'news', blocked: [] }], variables: [{ name: 'KEY', value: 'private-fixture', secret: true }] }]])
  const records = new Map<string, ExecutionPreparationRecord>(), retained: string[][] = []
  const keep = <T>(map: Map<string, T>, ids: readonly string[]) => { for (const id of map.keys()) if (!ids.includes(id)) map.delete(id) }
  const preparation = new ExecutionPreparation({ identities: () => exists ? ['skill:news'] : [], get: id => exists && usable ? { id, version: 'v1' } : undefined, owns: () => exists },
    { get: id => configs.get(id), list: () => [...configs].map(([owner, configuration]) => ({ owner, configuration })), retain: ids => keep(configs, ids) },
    { get: id => records.get(id), list: () => [...records.values()], save: (id, value) => { records.set(id, value) }, retain: ids => keep(records, ids) },
    { recover: async () => {}, identity: () => 'identity', collect: async ids => { retained.push([...ids]) }, prepare: async () => ({ id: 'artifact', version: 'v1', hash: 'hash', log: '' }) }, { now: () => 1 })
  await preparation.synchronize()
  usable = false; await preparation.changed()
  expect(configs.get('skill:news')?.variables[0]?.value).toBe('private-fixture') // A bundled-name conflict is not deletion.
  usable = true
  let finish!: () => void
  const running = preparation.withPrepared('skill:news', async artifact => { expect(artifact.id).toBe('artifact'); await new Promise<void>(resolve => { finish = resolve }); return 7 })
  exists = false; await preparation.changed()
  expect(configs.size).toBe(0); expect(preparation.view('skill:news')).toBeUndefined()
  expect(retained.at(-1)).toContain('artifact')
  finish(); expect(await running).toBe(7)
  expect(retained.at(-1)).toEqual([])
  await preparation.stop()
})

it('keeps staging artifacts until superseded preparation has actually stopped', async () => {
  const collections: string[][] = []
  const s = setup({ delayedAbort: true, collect: async ids => { collections.push([...ids]) } })
  const first = s.preparation.synchronize(); s.setVersion('v2'); const second = s.preparation.synchronize()
  expect(s.jobs[0]!.signal.aborted).toBe(true)
  s.jobs[1]!.resolve(s.artifact('new')); await second
  expect(collections).toHaveLength(0)
  s.jobs[0]!.resolve(s.artifact('obsolete')); await first
  expect(collections.at(-1)).toEqual(['new'])
  await s.preparation.stop()
})

it('waits for an in-flight artifact collection before creating a preparation stage', async () => {
  let entered!: () => void, release!: () => void
  const collecting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const s = setup({ collect: async () => { entered(); await held } })
  const recovered = s.preparation.recover(); await collecting
  const preparation = s.preparation.synchronize()
  expect(s.jobs).toHaveLength(0)
  release(); await recovered
  // The collector's completion starts the waiting preparation without a timer.
  await Promise.resolve()
  expect(s.jobs).toHaveLength(1)
  s.jobs[0]!.resolve(s.artifact('new')); await preparation
  expect(s.preparation.ready('skill:news').id).toBe('new')
  await s.preparation.stop()
})

it('waits for running execution and its final collection before shutdown, rejecting new calls', async () => {
  const s = setup(), preparation = s.preparation.synchronize()
  s.jobs[0]!.resolve(s.artifact('ready')); await preparation
  let finish!: () => void, stopped = false
  const running = s.preparation.withPrepared('skill:news', () => new Promise<void>(resolve => { finish = resolve }))
  const stopping = s.preparation.stop().then(() => { stopped = true })
  await expect(s.preparation.withPrepared('skill:news', async () => {})).rejects.toMatchObject({ code: 'internal' })
  expect(stopped).toBe(false)
  finish(); await running; await stopping
  expect(stopped).toBe(true)
})

it('does not run contribution dependency preparation until an administrator explicitly approves it', async () => {
  const s = setup(); s.setConfig({ awaitingPreparation: true })
  await s.preparation.synchronize(); expect(s.jobs).toEqual([])
  s.preparation.start(); await s.preparation.changed(); expect(s.jobs).toEqual([])
  s.setConfig({ awaitingPreparation: false })
  const preparing = s.preparation.refresh('skill:news')
  expect(s.jobs).toHaveLength(1); s.jobs[0]!.resolve(s.artifact('approved')); await preparing
  expect(s.preparation.ready('skill:news').id).toBe('approved'); await s.preparation.stop()
})
