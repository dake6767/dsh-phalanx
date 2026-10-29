import { expect, it } from 'vitest'
import { SuiteCatalog } from '../src/use-cases/suite-catalog.js'
import { postgresSuiteService, suiteVersion } from './fixtures/postgres-suite-service.js'
import { fixtureGallery } from './fixtures/suite-gallery.js'

it('drains accepted credential saves before stop returns and refuses later saves', async () => {
  const f = await postgresSuiteService()
  let release!: () => void,
    entered!: () => void,
    stopped = false,
    saving: Promise<void> | undefined,
    stopping: Promise<void> | undefined
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  let suites: SuiteCatalog | undefined
  const original = f.execution.saveSuiteCredentials.bind(f.execution)
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-credentials-1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    await f.suites.stop()
    suites = new SuiteCatalog(
      f.accounts,
      fixtureGallery([suiteVersion(1)]),
      f.store,
      f.dependencies,
      { now: () => 2 },
      'amd64',
      f.library,
      f.packs,
      f.execution,
    )
    f.execution.saveSuiteCredentials = async (...args) => {
      entered()
      await gate
      await original(...args)
    }
    saving = suites.saveCredentials(f.actor, 'fixture-suite', { SUITE_KEY: 'fictional-next-key' })
    await began
    stopping = suites.stop().then(() => {
      stopped = true
    })
    await f.database.query('SELECT 1')
    expect(stopped).toBe(false)
    await expect(suites.saveCredentials(f.actor, 'fixture-suite', { SUITE_KEY: 'too-late' })).rejects.toMatchObject({ code: 'suite-task-running' })
    release()
    await saving
    await stopping
    expect((await f.runtime.execution.get('skill:one'))?.variables).toContainEqual({ name: 'SUITE_KEY', value: 'fictional-next-key', secret: true })
  } finally {
    release()
    await Promise.allSettled([...(saving ? [saving] : []), ...(stopping ? [stopping] : [])])
    f.execution.saveSuiteCredentials = original
    await suites?.stop()
    await f.close()
  }
})
