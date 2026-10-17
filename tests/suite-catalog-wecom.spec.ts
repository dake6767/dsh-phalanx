import { expect, it } from 'vitest'
import { suiteCatalog, suiteRuntimeDependencyDefinition, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem, type SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'

const wecom = suiteCatalog.find((entry): entry is SuiteCatalogSuiteEntry => entry.id === 'wecom' && entry.category === 'suite')!

it('ships WeCom as a member sign-in suite: no delegated execution and no credential fields', () => {
  expect(wecom.items.map(item => item.kind)).toEqual(['runtime-dependency', 'skill', 'skill-pack'])
  for (const locale of ['en', 'zh-CN'] as const) {
    expect(wecom.identity[locale]).toContain('wecom-cli auth init')
    expect(wecom.identity[locale]).toContain('wecom-cli auth show --status')
  }
})

it('pins the 0.1.15 per-architecture npm preparation and all fifteen upstream skills in one pack', () => {
  const tool = wecom.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
  expect(tool).toMatchObject({ name: 'wecom-tools', pathDirectories: ['node_modules/.bin'], checkCommand: 'wecom-cli --version', commands: ['wecom-cli'] })
  for (const [architecture, platform] of [['amd64', 'x64'], ['arm64', 'arm64']] as const) {
    const command = suiteRuntimeDependencyDefinition(tool, architecture)!.prepareCommand
    expect(command).toContain(`@wecom/cli@1.3.4 @wecom/cli-linux-${platform}@1.3.4`)
    expect(command).toContain('--ignore-scripts')
    // The configured npm download source decides the registry.
    expect(command).not.toContain('--registry')
  }
  const skills = wecom.items.find((item): item is SuiteCatalogSkillItem => item.kind === 'skill')!
  expect(skills.source).toEqual({ type: 'git', url: 'https://github.com/WecomTeam/wecom-cli', commit: 'f9b28151dc8d42f703db624fc9b26723c3c93fc5', path: 'skills' })
  expect(skills.names).toHaveLength(15)
  const pack = wecom.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack')!
  expect(pack).toMatchObject({ name: 'wecom', skills: skills.names })
  expect(pack.note).toContain('do not run `wecom-cli auth init` yourself')
})
