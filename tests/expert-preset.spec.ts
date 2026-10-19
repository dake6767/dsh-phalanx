import { expect, it } from 'vitest'
import { projectExpertPreset, unavailableExpertPresets } from '../src/dsh/expert-preset.js'

const expert = { id: 'ecommerce', name: 'Commerce', description: 'Marketing work', persona: 'Use a marketing workflow.', revision: 1 }
const base = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Base persona.' } }, { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }]

it.each([
  { requested: ['research'], available: ['research'], global: [], skills: ['research'], failures: [] },
  { requested: ['research', 'research', 'shared'], available: ['research'], global: ['shared'], skills: ['research'], failures: [] },
  { requested: ['research', 'missing'], available: ['research'], global: [], skills: ['research'], failures: ['skill:missing'] },
])('projects expert skills without changing base capability or global ownership: $requested', row => {
  const result = projectExpertPreset(expert, { base, requestedSkills: row.requested, availableSkills: row.available, globalSkills: row.global, skillsDirectory: '/experts/ecommerce/skills' })
  expect(result.skills).toEqual(row.skills)
  expect(result.failures).toEqual(row.failures)
  expect(result.preset.config.plugins[0]).toEqual({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Base persona.\n\nUse a marketing workflow.' } })
  expect(result.preset.config.plugins[1]).toEqual(base[1])
  expect(result.preset.config.plugins[2]).toMatchObject({ config: { providerName: 'phalanx-expert-ecommerce', includeDefaultRoots: false, customSkillDirs: ['/experts/ecommerce/skills'] } })
  expect(base[0]!.config!.prefix).toBe('Base persona.')
})

it('keeps preset identity across revisions and separates skill providers for different experts', () => {
  const input = { base, requestedSkills: [], availableSkills: [], globalSkills: [], skillsDirectory: '/experts/skills' }
  const before = projectExpertPreset(expert, input), after = projectExpertPreset({ ...expert, revision: 2 }, input)
  expect(before.preset.config.id).toBe('phalanx-expert-ecommerce')
  expect(after.preset.config.id).toBe(before.preset.config.id)
  expect(projectExpertPreset({ ...expert, id: 'other' }, input).preset.config.plugins[2]).toMatchObject({ config: { providerName: 'phalanx-expert-other' } })
})

it('reads registration and broken state through the official preset roster', () => {
  expect(unavailableExpertPresets({ presets: [{ id: 'healthy' }, { id: 'broken', broken: 'fixture failure' }] }, ['healthy', 'broken', 'missing'])).toEqual(['broken', 'missing'])
  expect(() => unavailableExpertPresets({}, ['healthy'])).toThrow()
})
