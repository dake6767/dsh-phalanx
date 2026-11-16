import { expect, it } from 'vitest'
import { latestHumanText } from './support/real-dsh-model.js'

it('keeps the human prompt when rc.3 adds or clears runtime context', () => {
  const prompt = { role: 'user', content: 'CALL_ALICE' }
  const reminder = {
    type: 'text',
    text: '<system-reminder>\nThe following information describes your current session:\n\nMode: read-only.\n</system-reminder>',
  }
  const cleared = '<system-reminder>\nCurrent runtime context: none. Earlier runtime-context snapshots no longer apply.\n</system-reminder>'

  expect(latestHumanText({ messages: [prompt, { role: 'user', content: [reminder] }] })).toBe('CALL_ALICE')
  expect(latestHumanText({ messages: [prompt, { role: 'user', content: cleared }] })).toBe('CALL_ALICE')
})
