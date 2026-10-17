import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { suiteCatalog, suiteRuntimeDependencyDefinition, type SuiteCatalogExecutionItem, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem, type SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'

const lark = suiteCatalog.find((entry): entry is SuiteCatalogSuiteEntry => entry.id === 'lark' && entry.category === 'suite')!
const tool = lark.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!

it('ships Feishu as a bot-identity suite with blocked identity commands and two app credentials', () => {
  expect(lark.items.map(item => item.kind)).toEqual(['runtime-dependency', 'skill', 'execution', 'skill-pack'])
  const execution = lark.items.find((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')!
  expect(execution).toMatchObject({ skill: 'lark-shared', runtimeDependency: 'feishu-tools', delegated: [{ command: 'lark-cli', blocked: ['config', 'auth', 'profile', 'update'] }] })
  expect(execution.variables.map(row => row.name)).toEqual(['LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_APP_SECRET'])
  // Personal identity is out of scope for this version; the identity text says so.
  expect(lark.identity.en).toContain('--as user')
  expect(lark.identity['zh-CN']).toContain('--as user')
})

it('keeps the accepted 0.1.15 bot wrapper and pins every upstream skill in one pack', () => {
  // The documented manual recipe and the catalog must stay the same wrapper.
  const documented = readFileSync('docs/skill-execution.md', 'utf8').match(/cat > bin\/lark-cli <<'JS'\n[\s\S]*?\nJS\n/u)![0]
  for (const [architecture, asset, sha] of [['amd64', 'amd64', '4a12dcb7a0aab25986d8bcd046cb45b08278531a9aac3a12b53cf3d94738fe80'], ['arm64', 'arm64', 'f798b26ce4b369d70411945e7f66bbe4382c411bc47d81950a662de7b69b41ed']] as const) {
    const command = suiteRuntimeDependencyDefinition(tool, architecture)!.prepareCommand
    expect(command).toContain(`\${GITHUB_ASSETS_PREFIX}https://github.com/larksuite/cli/releases/download/v1.0.98/lark-cli-1.0.98-linux-${asset}.tar.gz`)
    expect(command).toContain(`echo "${sha}  lark.tgz" | sha256sum -c -`)
    expect(command).toContain(documented)
  }
  expect(tool).toMatchObject({ name: 'feishu-tools', pathDirectories: ['bin'], checkCommand: 'lark-cli --version', commands: ['lark-cli'] })
  const skills = lark.items.find((item): item is SuiteCatalogSkillItem => item.kind === 'skill')!
  expect(skills.source).toEqual({ type: 'git', url: 'https://github.com/larksuite/cli', commit: 'ac81f5056ab88f37d581d25916f3dab85abfca76', path: 'skills' })
  expect(skills.names).toHaveLength(28)
  // Delegation alone provides lark-cli; the skills declare no runtime dependency of their own.
  expect(skills.runtimeDependency).toBeUndefined()
  const pack = lark.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack')!
  expect(pack).toMatchObject({ name: 'lark', skills: skills.names })
  expect(pack.note).toContain('personal identity (`--as user`) is not available')
})
