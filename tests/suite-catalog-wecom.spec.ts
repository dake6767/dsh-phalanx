import { expect, it } from 'vitest'
import {
  suiteRuntimeDependencyDefinition,
  type SuiteCatalogRuntimeDependencyItem,
  type SuiteCatalogSkillItem,
  type SuiteCatalogSkillPackItem,
  type SuiteCatalogSuiteEntry,
} from '../src/domain/suite-catalog.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { legacyPrepareCommands, onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

/** WeCom ships declaratively online; these assertions pin the 0.1.18 behavior of the generated entry. */
const key = createCatalogSigningKey()
const read = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
if (read.status !== 'ok') throw new Error('fixture catalog was rejected')
const wecom = read.entries.find(row => row.entry.id === 'wecom')!.entry as SuiteCatalogSuiteEntry

it('ships WeCom as a member sign-in suite: no delegated execution and no credential fields', () => {
  expect(wecom.items.map(item => item.kind)).toEqual(['runtime-dependency', 'skill', 'skill-pack'])
  for (const locale of ['en', 'zh-CN'] as const) {
    expect(wecom.identity[locale]).toContain('wecom-cli auth init')
    expect(wecom.identity[locale]).toContain('wecom-cli auth show --status')
  }
})

it('generates the pinned per-architecture npm preparation and all fifteen upstream skills in one pack', () => {
  const tool = wecom.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
  expect(tool).toMatchObject({ name: 'wecom-tools', pathDirectories: ['node_modules/.bin'], checkCommand: 'wecom-cli --version', commands: ['wecom-cli'] })
  for (const architecture of ['amd64', 'arm64'] as const) {
    const command = suiteRuntimeDependencyDefinition(tool, architecture)!.prepareCommand
    // The 0.1.18 WeCom definition used the platform's canonical style, so the generated command matches exactly.
    expect(command).toBe(legacyPrepareCommands.wecom![architecture])
    expect(command).toContain(`@wecom/cli@1.3.4 @wecom/cli-linux-${architecture === 'amd64' ? 'x64' : 'arm64'}@1.3.4`)
    expect(command).toContain('--ignore-scripts')
    // The configured npm download source decides the registry.
    expect(command).not.toContain('--registry')
  }
  const skills = wecom.items.find((item): item is SuiteCatalogSkillItem => item.kind === 'skill')!
  expect(skills.source).toEqual({
    type: 'git',
    url: 'https://github.com/WecomTeam/wecom-cli',
    commit: 'f9b28151dc8d42f703db624fc9b26723c3c93fc5',
    path: 'skills',
  })
  expect(skills.names).toHaveLength(15)
  const pack = wecom.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack')!
  expect(pack).toMatchObject({ name: 'wecom', skills: skills.names })
  expect(pack.note).toContain('do not run `wecom-cli auth init` yourself')
})
