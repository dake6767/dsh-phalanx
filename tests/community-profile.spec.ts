import { expect, it } from 'vitest'
import { supplyCommunityDefaults } from '../src/dsh/community-profile.js'

it('leaves a complete private model override unchanged, including comments and JS expressions', () => {
  const privatePatch = `# User-owned configuration\n- id: agent-default-model\n  config:\n    provider: personal\n    model: private-model\n- id: llm-deepseek\n  disabled: true\n- id: custom\n  config:\n    value: !!js process.env.USER_SETTING\n`
  expect(supplyCommunityDefaults(privatePatch, 'deepseek-official', 'deepseek-chat')).toBe(privatePatch)
})
it('supplies missing platform defaults while keeping an existing private model choice', () => {
  const patch = supplyCommunityDefaults('- id: agent-default-model\n  config:\n    provider: personal\n    model: private-model\n', 'deepseek-official', 'deepseek-chat')
  expect(patch).toContain('provider: personal')
  expect(patch).toContain('model: private-model')
  expect(patch).toContain('id: llm-deepseek')
  expect(patch).not.toContain('provider: deepseek-official')
  expect(supplyCommunityDefaults(patch, 'different-default', 'different-model')).toBe(patch)
})
