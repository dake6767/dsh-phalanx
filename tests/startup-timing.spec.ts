import { expect, it } from 'vitest'
import { StartupTiming } from '../src/adapters/startup-timing.js'
it('records overlay phases and background checking without any member data', async () => {
  let now = 0
  const receipts: unknown[] = [], stages: string[] = []
  const timing = new StartupTiming(stage => stages.push(stage), () => now, receipt => receipts.push(receipt))
  now = 3; timing.advance('starting'); now = 8; timing.advance('connecting'); now = 10; timing.finish()
  await timing.checking(async () => { now = 15 })
  expect(stages).toEqual(['starting', 'connecting'])
  expect(receipts).toEqual(['preparing', 'starting', 'connecting', 'checking'].map((stage, index) => ({ event: 'community-startup-phase', stage, durationMs: [3, 5, 2, 5][index] })))
})
