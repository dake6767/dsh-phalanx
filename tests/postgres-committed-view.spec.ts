import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { PostgresCommittedView } from '../src/adapters/postgres-committed-view.js'
import { openTestDatabase } from './support/community-application.js'

it('coalesces concurrent commits without publishing a captured older snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ordered-view-'))
  const database = await openTestDatabase(root)
  let pause = false,
    entered!: () => void,
    release!: () => void,
    loads = 0
  const began = new Promise<void>(resolve => {
    entered = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const view = new PostgresCommittedView(database, ['dsh_phalanx.groups'], async () => {
    const rows = await database.query<{ name: string }>('SELECT name FROM dsh_phalanx.groups WHERE id=$1', ['default'])
    loads++
    if (pause) {
      pause = false
      entered()
      await gate
    }
    return rows[0]!
  })
  const writes: Promise<unknown>[] = []
  try {
    await view.initialize()
    pause = true
    writes.push(database.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['First', 'default']))
    await began
    writes.push(database.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Second', 'default']))
    await expect
      .poll(async () => (await database.query<{ name: string }>('SELECT name FROM dsh_phalanx.groups WHERE id=$1', ['default']))[0]?.name)
      .toBe('Second')
    expect(() => view.read(row => row.name)).toThrow()
    release()
    await Promise.all(writes)
    expect(view.read(row => row.name)).toBe('Second')
    expect(loads).toBe(3)
  } finally {
    release()
    await Promise.allSettled(writes)
    await view.close()
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('fails closed after a publication error and reloads committed facts without publishing a rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unavailable-view-'))
  const database = await openTestDatabase(root)
  let failed = false,
    loads = 0
  const view = new PostgresCommittedView(database, ['dsh_phalanx.groups'], async () => {
    loads++
    if (failed) throw Error('reload refused')
    return await database.query<{ name: string }>('SELECT name FROM dsh_phalanx.groups WHERE id=$1', ['default'])
  })
  try {
    await view.initialize()
    failed = true
    await expect(database.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Committed', 'default'])).rejects.toThrow('reload refused')
    expect(() => view.read(rows => rows[0]?.name)).toThrow()
    failed = false
    await view.ready()
    expect(view.read(rows => rows[0]?.name)).toBe('Committed')
    const before = loads
    await expect(
      database.transaction(async sql => {
        await sql.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Refused', 'default'])
        throw Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(loads).toBe(before)
    expect(view.read(rows => rows[0]?.name)).toBe('Committed')
    const borrowed = view.read(rows => rows)
    borrowed[0]!.name = 'mutated'
    expect(view.read(rows => rows[0]?.name)).toBe('Committed')
  } finally {
    await view.close()
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('refreshes a commit delivered between snapshot publication and loading cleanup', async () => {
  let generation = 0,
    loads = 0,
    schedule = false
  let publish!: () => Promise<void>, second: Promise<void> | undefined
  const view = new PostgresCommittedView(
    {
      writeRevision: () => String(generation),
      subscribeCommittedWrites: (_tables, listener) => {
        publish = listener
        return () => {}
      },
    },
    ['facts'],
    async () => {
      loads++
      const snapshot = generation
      if (schedule) {
        schedule = false
        queueMicrotask(() =>
          queueMicrotask(() => {
            generation = 2
            second = publish()
          }),
        )
      }
      return snapshot
    },
  )
  try {
    await view.initialize()
    generation = 1
    schedule = true
    await publish()
    expect(second).toBeDefined()
    await second
    expect(view.read(value => value)).toBe(2)
    expect(loads).toBe(3)
  } finally {
    await view.close()
  }
})
