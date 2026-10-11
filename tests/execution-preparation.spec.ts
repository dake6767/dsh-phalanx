import { expect, it } from 'vitest'
import { ExecutionPreparation } from '../src/use-cases/execution-preparation.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../src/domain/platform-execution.js'
import type { PreparedExecution, ExecutionPreparationRecord } from '../src/domain/execution-preparation.js'

function setup() {
  let owner: ExecutionOwner = { id: 'skill:news', version: 'v1' }, image = 'image1'
  let config: ExecutionConfiguration = { enabled: true, commands: [{ command: 'news', blocked: [] }], variables: [{ name: 'KEY', value: 'one', secret: true }], prepare: 'prepare' }
  let failWrite = false
  const records = new Map<string, ExecutionPreparationRecord>()
  const jobs: { resolve: (value: PreparedExecution) => void, reject: (error: Error) => void, signal: AbortSignal }[] = []
  const preparation = new ExecutionPreparation({ get: () => owner, owns: () => true }, { get: () => config, list: () => [{ owner: owner.id, configuration: config }] }, {
    list: () => [...records.values()], get: id => records.get(id), save: (id, value) => { if (failWrite) { failWrite = false; throw new Error('ENOSPC') }; records.set(id, value) },
  }, {
    identity: (target, value) => JSON.stringify([target.version, value.prepare, value.variables, image]), recover: async () => {}, collect: async () => {},
    prepare: async (_owner, _configuration, signal) => new Promise((resolve, reject) => {
      jobs.push({ resolve, reject, signal }); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
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
