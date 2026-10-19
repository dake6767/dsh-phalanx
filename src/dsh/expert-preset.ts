export const expertPresetId = (id: string) => `phalanx-expert-${id}`

/** The fixed-runtime preset projection; all filesystem preparation belongs to its adapter. */
export function projectExpertPreset(expert: { readonly id: string, readonly name: string, readonly description: string, readonly persona: string, readonly revision: number }, input: {
  readonly base: readonly Record<string, unknown>[], readonly requestedSkills: readonly string[], readonly availableSkills: readonly string[],
  readonly globalSkills: readonly string[], readonly skillsDirectory: string,
  readonly pluginProjection?: { readonly requested: readonly string[], readonly global: readonly string[], readonly available: readonly { readonly packageName: string, readonly entries: readonly Record<string, unknown>[], readonly services: readonly string[] }[], readonly loader: string },
}) {
  const plugins = structuredClone([...input.base])
  const persona = plugins.find(row => row.id === 'persona')
  if (!persona || !persona.config || typeof persona.config !== 'object' || Array.isArray(persona.config)) throw new Error('Expert base persona is unavailable')
  const config = persona.config as Record<string, unknown>
  if (typeof config.prefix !== 'string') throw new Error('Expert base persona is invalid')
  config.prefix += `\n\n${expert.persona}`
  const global = new Set(input.globalSkills), available = new Set(input.availableSkills)
  const requested = [...new Set(input.requestedSkills)].sort()
  const skills = requested.filter(name => !global.has(name) && available.has(name))
  const failures = requested.filter(name => !global.has(name) && !available.has(name)).map(name => `skill:${name}`)
  const id = expertPresetId(expert.id)
  if (input.pluginProjection) {
    const projection = input.pluginProjection
    const packages = [...new Set(projection.requested)].filter(name => !projection.global.includes(name)).flatMap(name => {
      const prepared = projection.available.find(row => row.packageName === name)
      if (!prepared) { failures.push(`plugin:${name}`); return [] }
      return [prepared]
    })
    if (packages.length) plugins.push({ id: `${id}-plugins`, name: projection.loader,
      config: { id: expert.id, services: [...new Set(packages.flatMap(row => row.services))].sort(), packages: structuredClone(packages) } })
  }
  plugins.push({ id: `${id}-skills`, name: '@deepseek-ai/dsh-skill-filesystem', config: { providerName: id, includeDefaultRoots: false, customSkillDirs: [input.skillsDirectory] } })
  return { skills, failures, preset: { id, name: '@deepseek-ai/dsh-agent-preset', config: { id, name: expert.name, description: expert.description, plugins } } }
}

export const DSH_EXPERT_PRESETS_LIST = 'agentPresets/list'

/** Official roster: absent or broken declarations cannot be used as a working preset. */
export function unavailableExpertPresets(value: unknown, expected: readonly string[]): string[] {
  if (!value || typeof value !== 'object' || !('presets' in value) || !Array.isArray(value.presets)) throw new Error('Expert roster unavailable')
  const presets = value.presets as unknown[]
  return expected.filter(id => !presets.some(row => row && typeof row === 'object' && 'id' in row && row.id === id && !('broken' in row && row.broken)))
}
