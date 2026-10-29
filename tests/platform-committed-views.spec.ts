import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { openTestDatabase } from './support/community-application.js'

it('invalidates after commit and awaits publication before resolving, while a rollback never publishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'committed-view-'))
  const database = await openTestDatabase(root)
  let release!: () => void,
    entered!: () => void,
    completed = false,
    available = true
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const began = new Promise<void>(resolve => {
    entered = resolve
  })
  let published: unknown,
    events = 0
  let unsubscribe = () => {}
  const observe = () =>
    database.subscribeCommittedWrites(['dsh_phalanx.groups'], async () => {
      available = false
      events++
      const rows = await database.query('SELECT name FROM dsh_phalanx.groups WHERE id=$1', ['default'])
      entered()
      await gate
      published = rows
      available = true
    })
  let writing: Promise<unknown> | undefined
  try {
    unsubscribe = observe()
    writing = database
      .transaction(async sql => {
        await sql.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Committed', 'default'])
      })
      .then(() => {
        completed = true
      })
    await began
    expect(available).toBe(false)
    expect(completed).toBe(false)
    release()
    await writing
    expect(published).toEqual([{ name: 'Committed' }])
    expect(available).toBe(true)
    await expect(
      database.transaction(async sql => {
        await sql.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Rolled back', 'default'])
        throw Error('refused')
      }),
    ).rejects.toThrow('refused')
    expect(events).toBe(1)
    unsubscribe()
    await database.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Unsubscribed', 'default'])
    expect(events).toBe(1)
  } finally {
    release()
    await writing?.catch(() => {})
    unsubscribe()
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('keeps committed facts and invalidated state when a publication fails after commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'failed-view-'))
  const database = await openTestDatabase(root)
  let invalidated = false
  let unsubscribe = () => {}
  const observe = () =>
    database.subscribeCommittedWrites(['dsh_phalanx.groups'], async () => {
      invalidated = true
      throw Error('view publication refused')
    })
  try {
    unsubscribe = observe()
    await expect(
      database.transaction(async sql => {
        await sql.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Committed', 'default'])
      }),
    ).rejects.toThrow('view publication refused')
    expect(invalidated).toBe(true)
    expect(await database.query('SELECT name FROM dsh_phalanx.groups WHERE id=$1', ['default'])).toEqual([{ name: 'Committed' }])
  } finally {
    unsubscribe()
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('releases committed writer connections before publication borrows from the same bounded pool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pooled-view-'))
  const database = await openTestDatabase(root)
  let publications = 0
  let unsubscribe = () => {}
  const observe = () =>
    database.subscribeCommittedWrites(['dsh_phalanx.groups'], async () => {
      await database.query('SELECT name FROM dsh_phalanx.groups WHERE id=$1', ['default'])
      publications++
    })
  try {
    unsubscribe = observe()
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => database.query('UPDATE dsh_phalanx.groups SET name=$1 WHERE id=$2', ['Name ' + index, 'default'])),
    )
    expect(publications).toBe(8)
  } finally {
    unsubscribe()
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
