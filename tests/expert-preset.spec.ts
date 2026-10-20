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

it('projects only expert-local prepared plugin includes and supplies service isolation without duplicating globals', () => {
  const result = projectExpertPreset(expert, { base, requestedSkills: [], availableSkills: [], globalSkills: [], skillsDirectory: '/experts/skills',
    pluginProjection: { requested: ['global', 'service', 'missing', 'service'], global: ['global'], loader: '/experts/loader.mjs', available: [
      { packageName: 'service', services: ['weather'], entries: [{ id: 'service-layer', name: '@deepseek-ai/cordis-plugin-include', config: { path: '/managed/service.json' } }] },
    ] } })
  expect(result.failures).toEqual(['plugin:missing'])
  expect(result.preset.config.plugins[2]).toEqual({ id: 'phalanx-expert-ecommerce-plugins', name: '/experts/loader.mjs', config: {
    id: 'ecommerce', services: ['weather'], packages: [{ packageName: 'service', services: ['weather'], entries: [{ id: 'service-layer', name: '@deepseek-ai/cordis-plugin-include', config: { path: '/managed/service.json' } }] }],
  } })
})

it.each(['remote', 'shared', 'member'])('projects the %s MCP client into the expert without duplicating globals or credentials', location => {
  const config = location === 'remote' ? { transport: 'streamable-http', url: { __jsExpr: 'memberGatewayUrl' } } : { transport: 'stdio', command: 'node', args: ['member-wrapper.mjs'] }
  const result = projectExpertPreset(expert, { base, requestedSkills: [], availableSkills: [], globalSkills: [], skillsDirectory: '/experts/skills', mcpProjection: {
    loader: '/experts/loader.mjs', requested: ['p-shared', 'p-special', 'p-special', 'p-missing'], global: ['p-shared'], available: [{ name: 'p-special', entry: { id: 'phalanx-mcp-p-special', name: 'mcp-client', config } }],
  }, pluginProjection: { requested: ['service'], global: [], loader: '/experts/loader.mjs', available: [{ packageName: 'service', services: ['weather'], entries: [{ id: 'service-layer', name: 'fixture-plugin' }] }] } })
  expect(result.failures).toEqual(['mcp:p-missing'])
  expect(result.preset.config.plugins.map(row => row.id)).toEqual(['persona', 'tool-bash', 'phalanx-expert-ecommerce-plugins', 'phalanx-expert-ecommerce-skills', 'phalanx-expert-ecommerce-mcp'])
  expect(result.preset.config.plugins.at(-1)).toEqual({ id: 'phalanx-expert-ecommerce-mcp', name: '/experts/loader.mjs', config: { id: 'ecommerce', services: [], packages: [{ failureId: 'mcp:p-special', services: [], entries: [{ id: 'phalanx-mcp-p-special', name: 'mcp-client', config }] }] } })
  expect(JSON.stringify(result.preset.config.plugins).match(/mcp-client/gu)).toHaveLength(1)
})

it('contains each expert MCP client in the protected loader after skills so a failed client cannot break the preset', () => {
  const result = projectExpertPreset(expert, { base, requestedSkills: [], availableSkills: [], globalSkills: [], skillsDirectory: '/experts/skills',
    pluginProjection: { requested: [], global: [], available: [], loader: '/experts/loader.mjs' },
    mcpProjection: { loader: '/experts/loader.mjs', requested: ['p-good', 'p-bad'], global: [], available: ['p-good', 'p-bad'].map(name => ({ name, entry: { id: name, name: 'mcp-client', config: { service: name } } })) } })
  expect(result.preset.config.plugins.map(row => row.id)).toEqual(['persona', 'tool-bash', 'phalanx-expert-ecommerce-skills', 'phalanx-expert-ecommerce-mcp'])
  expect(result.preset.config.plugins.at(-1)).toEqual({ id: 'phalanx-expert-ecommerce-mcp', name: '/experts/loader.mjs', config: { id: 'ecommerce', services: [], packages: [
    { failureId: 'mcp:p-good', services: [], entries: [{ id: 'p-good', name: 'mcp-client', config: { service: 'p-good' } }] },
    { failureId: 'mcp:p-bad', services: [], entries: [{ id: 'p-bad', name: 'mcp-client', config: { service: 'p-bad' } }] },
  ] } })
})
