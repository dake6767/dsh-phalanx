import { expect, it } from 'vitest'
import { actor, fixture, suitePreset } from './fixtures/suite-catalog.js'

it('reads current install rows on every public preview instead of holding a catalog state snapshot', async () => {
  const f = fixture()
  expect((await f.suites.installPreview(actor, 'fixture-suite')).reason).toBeUndefined()
  await f.storage.installs.save({ id: 'fixture-suite', version: '1', status: 'installed', entries: [], log: 'Installed by another writer.', updatedAt: 1 })
  expect((await f.suites.installPreview(actor, 'fixture-suite')).reason).toBe('already-installed')
  const current = (await f.storage.installs.get('fixture-suite'))!
  await f.storage.installs.save({ ...current.record, status: 'failed' }, current.revision)
  expect((await f.suites.installPreview(actor, 'fixture-suite')).reason).toBeUndefined()
  expect((await f.suites.catalog(actor)).installations[0]?.status).toBe('failed')
})

it('keeps installed facts visible when the online catalog no longer lists the entry', async () => {
  const f = fixture(suitePreset())
  await f.storage.installs.save({
    id: 'fixture-suite',
    version: '1',
    status: 'installed',
    entries: [{ kind: 'skill', name: 'one' }],
    log: 'Installed.',
    updatedAt: 1,
  })
  f.upgrade([])
  const view = await f.suites.catalog(actor)
  expect(view.entries).toEqual([])
  expect(view.installations).toMatchObject([{ id: 'fixture-suite', version: '1', status: 'installed', entries: [{ kind: 'skill', name: 'one' }] }])
})
