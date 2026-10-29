import { expect, it } from 'vitest'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('attempts later owned cleanup in order and retains earlier close failures', async () => {
  const events: string[] = [],
    failure = Error('store close failed')
  await expect(
    cleanupOwned(
      async () => {
        events.push('store')
        throw failure
      },
      async () => {
        events.push('database')
      },
      async () => {
        events.push('root')
      },
    ),
  ).rejects.toMatchObject({ errors: [failure] })
  expect(events).toEqual(['store', 'database', 'root'])
})
