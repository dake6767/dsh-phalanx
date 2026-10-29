import { expect, it } from 'vitest'
import { writeSuiteSkills } from '../src/use-cases/suite-skill-facts.js'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { postgresSuiteService } from './fixtures/postgres-suite-service.js'

it('keeps manual replacement publication and rejects a changed confirmed source without touching unrelated rows', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    const manual = { name: 'one', description: 'Manual', hash: 'a'.repeat(64), importedAt: 1, published: true }
    await f.storage.library.save(manual)
    await f.storage.library.save({ ...manual, name: 'other', published: false })
    const confirmed = (await f.storage.library.list()).find(row => row.name === 'one')!,
      unrelated = (await f.storage.library.list()).find(row => row.name === 'other')!,
      prepared = [{ ...manual, description: 'Catalog', hash: 'b'.repeat(64), importedAt: 2, published: false, suiteOrigin: 'suite:fixture' }]
    await f.storage.library.save({ ...confirmed, hash: 'c'.repeat(64) })
    await expect(
      storage.work.run(rows => writeSuiteSkills(rows, 'suite:fixture', prepared, [], { kind: 'install', replacing: [confirmed] })),
    ).rejects.toMatchObject({ code: 'suite-replace-unconfirmed' })
    const current = (await f.storage.library.list()).find(row => row.name === 'one')!
    await storage.work.run(rows => writeSuiteSkills(rows, 'suite:fixture', prepared, [], { kind: 'install', replacing: [current] }))
    expect((await f.storage.library.list()).find(row => row.name === 'one')).toMatchObject({
      published: true,
      hash: 'b'.repeat(64),
      suiteOrigin: 'suite:fixture',
    })
    expect((await f.storage.library.list()).find(row => row.name === 'other')).toEqual(unrelated)
  } finally {
    await f.close()
  }
})

it('keeps prepared skill writes inside the caller COMMIT and preserves imported time for identical update content', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    const original = { name: 'one', description: 'Old', hash: 'a'.repeat(64), importedAt: 1, published: true, suiteOrigin: 'suite:fixture' }
    await f.storage.library.save(original)
    const before = await f.storage.library.list(),
      prepared = [{ ...original, description: 'New', published: false, importedAt: 2 }]
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_skill_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_skill_child(id integer REFERENCES dsh_phalanx.reject_skill_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_skill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_skill_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_skill AFTER INSERT ON dsh_phalanx.catalog_installs FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_skill();`)
    const commit = () =>
      storage.work.run(async rows => {
        await writeSuiteSkills(rows, 'suite:fixture', prepared, [], { kind: 'update' })
        await rows.installs.save({
          id: 'fixture',
          version: '2',
          status: 'installed',
          entries: [{ kind: 'skill', name: 'one' }],
          updatedAt: 2,
          log: 'Installed.',
        })
      })
    await expect(commit()).rejects.toMatchObject({ sqlState: '23503' })
    expect(await f.storage.library.list()).toEqual(before)
    await f.database.query('DROP TRIGGER reject_skill ON dsh_phalanx.catalog_installs')
    await commit()
    expect((await f.storage.library.list())[0]).toMatchObject({ description: 'New', published: true, importedAt: 1 })
  } finally {
    await f.close()
  }
})
