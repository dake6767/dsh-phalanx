import { expect, it } from 'vitest'
import type { PlatformUnitOfWorkPort } from '../src/ports/platform-unit-of-work.js'

/**
 * A fake unit of work with the port's contract: writes are staged per run and
 * applied only when the operation returns. Use-case tests can depend on this
 * without PostgreSQL; the real adapter is covered by postgres-unit-of-work.spec.
 */
class FakeUnitOfWork implements PlatformUnitOfWorkPort<{ ledger: { add(entry: string): void } }> {
  readonly committed: string[] = []
  async run<T>(operation: (repositories: { ledger: { add(entry: string): void } }) => Promise<T>): Promise<T> {
    const staged: string[] = []
    const result = await operation({ ledger: { add: entry => void staged.push(entry) } })
    this.committed.push(...staged)
    return result
  }
}

it('commits everything an operation staged, or nothing when it throws', async () => {
  const unit = new FakeUnitOfWork()
  await expect(
    unit.run(async ({ ledger }) => {
      ledger.add('first')
      throw Error('stop')
    }),
  ).rejects.toThrow('stop')
  expect(unit.committed).toEqual([])
  expect(await unit.run(async ({ ledger }) => (ledger.add('second'), ledger.add('third'), 'done'))).toBe('done')
  expect(unit.committed).toEqual(['second', 'third'])
})
