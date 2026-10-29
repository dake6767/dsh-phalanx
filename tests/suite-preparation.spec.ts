import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { runtimeVersion } from './fixtures/runtime-version.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { postgresSuiteService, suiteVersion } from './fixtures/postgres-suite-service.js'

it('retains a prepared runtime artifact while later Git preparation and garbage collection run before catalog COMMIT', async () => {
  const f = await postgresSuiteService()
  let survived = false
  try {
    f.hooks.beforeGit = async () => {
      const prepared = [...f.preparedArtifacts]
      expect(prepared).toHaveLength(1)
      await f.dependencies.collectUnretained()
      survived = prepared.every(id => f.preparedArtifacts.has(id))
    }
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    expect(survived).toBe(true)
    const current = (await f.runtime.store.list())[0]!.current!
    expect(f.preparedArtifacts.has(current.id)).toBe(true)
    expect(await readFile(join(current.directory, 'prepared'), 'utf8')).toBe('prepared runtime fixture')
  } finally {
    await f.close()
  }
})

it('keeps a successful catalog commit when later runtime artifact collection fails', async () => {
  const f = await postgresSuiteService()
  let refused = false
  try {
    f.hooks.beforeCollect = async () => {
      if (!refused && (await f.record())?.status === 'installed') {
        refused = true
        throw Error('fixture collection unavailable')
      }
    }
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await expect.poll(async () => (await f.record())?.status).not.toBe('installing')
    await f.suites.stop()
    expect(refused).toBe(true)
    expect((await f.record())?.status).toBe('installed')
    expect((await f.storage.library.list()).map(row => row.name)).toEqual(['obsolete', 'one'])
    expect(await f.runtime.store.list()).toHaveLength(1)
  } finally {
    await f.close()
  }
})

it.each(['runtime', 'Git', 'cancelled'] as const)('releases the candidate and staging lifetime after %s preparation fails', async failure => {
  const f = await postgresSuiteService()
  let collections = 0
  try {
    const reject = async () => {
      throw failure === 'cancelled' ? new DOMException('Cancelled', 'AbortError') : Error('fixture preparation failed')
    }
    if (failure === 'runtime') f.hooks.beforeRuntime = reject
    else f.hooks.beforeGit = reject
    f.hooks.beforeCollect = async () => {
      collections++
    }
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await expect.poll(async () => (await f.record())?.status).toBe('failed')
    await f.suites.stop()
    expect(f.preparedArtifacts.size).toBe(0)
    expect(collections).toBeGreaterThan(0)
    expect(await f.storage.library.list()).toEqual([])
    expect(await f.runtime.store.list()).toEqual([])
  } finally {
    await f.close()
  }
})

it('drains an accepted candidate waiting for collection and refuses new candidates after stop starts', async () => {
  const f = await postgresSuiteService()
  let release!: () => void,
    entered!: () => void,
    collection: Promise<void> | undefined,
    candidate: Promise<string> | undefined,
    stopping: Promise<void> | undefined
  let first = true,
    prepared = 0,
    ran = 0,
    stopped = false
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  try {
    f.hooks.beforeCollect = async () => {
      if (first) {
        first = false
        entered()
        await gate
      }
    }
    collection = f.dependencies.collectUnretained()
    await began
    const prepare = async () => {
        prepared++
        return runtimeVersion('a')
      },
      run = async () => {
        ran++
        return 'accepted'
      }
    candidate = f.dependencies.withPreparedVersion(prepare, run)
    stopping = f.dependencies.stop().then(() => {
      stopped = true
    })
    await expect(f.dependencies.withPreparedVersion(prepare, run)).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
    expect(prepared).toBe(0)
    expect(stopped).toBe(false)
    release()
    await collection
    await expect(candidate).resolves.toBe('accepted')
    await stopping
    expect(prepared).toBe(1)
    expect(ran).toBe(1)
    await expect(f.dependencies.withPreparedVersion(prepare, run)).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
    expect(prepared).toBe(1)
    expect(ran).toBe(1)
  } finally {
    release()
    await Promise.allSettled([...(collection ? [collection] : []), ...(candidate ? [candidate] : []), ...(stopping ? [stopping] : [])])
    await f.close()
  }
})

it('retains the next runtime version through Git preparation during catalog update', async () => {
  const f = await postgresSuiteService()
  let survived = false
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    f.hooks.beforeGit = async () => {
      const prepared = [...f.preparedArtifacts]
      expect(prepared).toHaveLength(2)
      await f.dependencies.collectUnretained()
      survived = prepared.every(id => f.preparedArtifacts.has(id))
    }
    f.upgrade(suiteVersion(2))
    await f.suites.update(f.actor, 'fixture-suite')
    await f.settled()
    await f.suites.stop()
    expect((await f.record())?.version).toBe('2')
    expect(survived).toBe(true)
    const current = (await f.runtime.store.list())[0]!.current!
    expect(await readFile(join(current.directory, 'prepared'), 'utf8')).toBe('prepared runtime fixture')
  } finally {
    await f.close()
  }
})

it('preserves the preparation error when candidate cleanup also fails', async () => {
  const f = await postgresSuiteService()
  try {
    f.hooks.beforeRuntime = async () => {
      throw Error('primary preparation failure')
    }
    f.hooks.beforeCollect = async () => {
      throw Error('secondary collection failure')
    }
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await expect.poll(async () => (await f.record())?.status).toBe('failed')
    await f.suites.stop()
    expect((await f.record())?.log).toContain('primary preparation failure')
    expect((await f.record())?.log).not.toContain('secondary collection failure')
    expect(await f.runtime.store.list()).toEqual([])
  } finally {
    await f.close()
  }
})

it.each(['commit', 'reject'] as const)('holds a prepared pack note through the %s callback and then releases its artifact lifetime', async outcome => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  let queued: Promise<void> | undefined,
    ran = false,
    hash = ''
  try {
    const operation = f.library.withSuiteNotes(
      [{ id: 'fixture-suite', name: 'fixture-suite', description: 'Fixture pack', instructions: 'Prepared instructions.' }],
      async notes => {
        const note = notes.get('fixture-suite')!
        hash = note.hash
        expect(await readFile(f.skillArtifactPath(hash), 'utf8')).toBe('prepared skill fixture')
        queued = f.library.mutate(async () => {
          ran = true
        })
        await f.database.query('SELECT 1')
        expect(ran).toBe(false)
        if (outcome === 'reject') throw Error('primary commit rejection')
        await storage.work.run(rows =>
          rows.packs.store.save({
            name: 'fixture-suite',
            description: 'Fixture pack',
            skills: [],
            instructions: 'Prepared instructions.',
            published: false,
            suiteOrigin: 'suite:fixture-suite',
            note,
          }),
        )
      },
    )
    if (outcome === 'reject') await expect(operation).rejects.toThrow('primary commit rejection')
    else await operation
    await queued
    expect(ran).toBe(true)
    expect(f.preparedSkillArtifacts.has(hash)).toBe(outcome === 'commit')
    if (outcome === 'commit') expect(await readFile(f.skillArtifactPath(hash), 'utf8')).toBe('prepared skill fixture')
  } finally {
    await queued?.catch(() => {})
    await f.close()
  }
})

it('exposes a stable prepared skill plan without consuming its staging owner before COMMIT', async () => {
  const f = await postgresSuiteService()
  try {
    await f.library.prepareSuiteImport(
      'suite:fixture',
      { url: 'https://git.example/repository', subpath: 'skills', ref: 'a'.repeat(40) },
      ['one'],
      async () => {},
      new AbortController().signal,
    )
    const prepared = f.library.preparedSuiteImport('suite:fixture')
    expect(prepared).toHaveLength(1)
    const hash = prepared[0]!.hash
    Object.assign(prepared[0]!, { hash: 'b'.repeat(64) })
    expect(f.library.preparedSuiteImport('suite:fixture')[0]!.hash).toBe(hash)
    expect(await f.storage.library.list()).toEqual([])
    expect(await readFile(f.skillArtifactPath(hash), 'utf8')).toBe('prepared skill fixture')
    await f.library.discardSuiteImport('suite:fixture')
    expect(f.preparedSkillArtifacts.has(hash)).toBe(false)
    expect(() => f.library.preparedSuiteImport('suite:fixture')).toThrow(expect.objectContaining({ code: 'suite-catalog-invalid' }))
  } finally {
    await f.close()
  }
})
