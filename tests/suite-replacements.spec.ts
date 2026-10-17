import { expect, it } from 'vitest'
import { planReplacements, replacementBusy, replacementConfirmed, replacementEntries } from '../src/use-cases/suite-replacements.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

const text = { en: 'entry', 'zh-CN': '条目' }
const suite: SuiteCatalogEntry = { category: 'suite', id: 'lark', version: '1', title: text, description: text, source: text, identity: text, dependencies: [],
  items: [{ kind: 'runtime-dependency', name: 'feishu-tools', prepareCommands: { amd64: 'x' }, pathDirectories: ['bin'], commands: ['lark-cli'] },
    { kind: 'skill', source: { type: 'git', url: 'https://github.com/larksuite/cli', commit: 'a'.repeat(40), path: 'skills' }, names: ['lark-im'] }] }
const row = (name: string, source: RuntimeDependency['source'], managedOrigin?: string): RuntimeDependency => ({ name, source, prepareCommand: 'x', pathDirectories: ['bin'], stage: 'ready', updatedAt: 0, log: '', checks: [], ...managedOrigin ? { managedOrigin } : {} })
const skill: LibrarySkill = { name: 'lark-im', description: 'im', hash: 'h', importedAt: 0, published: true }

it('replaces manual providers of the suite CLI and same-repository skills, and blocks catalog-owned providers', () => {
  const plan = planReplacements(suite, 'suite:lark', { commandOwners: () => [row('feishu-tools', 'manual'), row('lark-mcp', 'mcp-catalog'), row('own', 'suite-catalog', 'suite:lark')] }, { suiteReplaceable: () => [skill] })
  expect(plan.dependencies.map(next => [next.item, next.manual])).toEqual([['feishu-tools', 'feishu-tools']])
  expect(plan.skills).toEqual([skill])
  expect(plan.conflicts).toEqual(['lark-mcp'])
})

it('lets a standalone catalog dependency take over its manual twin', () => {
  const dependency: SuiteCatalogEntry = { category: 'dependency', id: 'ffmpeg', version: '1', title: text, description: text, source: text, items: [suite.items[0]!] }
  const plan = planReplacements(dependency, 'suite:ffmpeg', { commandOwners: () => [row('mine', 'manual')] }, { suiteReplaceable: () => [] })
  expect(plan).toMatchObject({ dependencies: [{ item: 'feishu-tools', manual: 'mine' }], skills: [], conflicts: [] })
})

it('takes over one manual provider per CLI and reports any further one as a conflict', () => {
  const plan = planReplacements(suite, 'suite:lark', { commandOwners: () => [row('first', 'manual'), row('second', 'migration-0.1.10')] }, { suiteReplaceable: () => [] })
  expect(plan.dependencies.map(next => next.manual)).toEqual(['first'])
  expect(plan.conflicts).toEqual(['second'])
})

it('accepts only a confirmation listing exactly the planned replacements and reports rows another install holds', () => {
  const plan = planReplacements(suite, 'suite:lark', { commandOwners: () => [row('feishu-tools', 'manual')] }, { suiteReplaceable: () => [skill] })
  expect(replacementEntries(plan)).toEqual([{ kind: 'runtime-dependency', name: 'feishu-tools' }, { kind: 'skill', name: 'lark-im' }])
  expect(replacementConfirmed(plan, [{ kind: 'skill', name: 'lark-im' }, { kind: 'runtime-dependency', name: 'feishu-tools' }])).toBe(true)
  expect(replacementConfirmed(plan, [{ kind: 'skill', name: 'lark-im' }])).toBe(false)
  expect(replacementConfirmed(plan)).toBe(false)
  expect(replacementConfirmed(planReplacements(suite, 'suite:lark', { commandOwners: () => [] }, { suiteReplaceable: () => [] }))).toBe(true)
  expect(replacementBusy(plan, [])).toBe(false)
  expect(replacementBusy(plan, [{ id: 'other', version: '1', status: 'failed', entries: [], updatedAt: 0, log: '', replacing: { dependencies: [], skills: [skill], executions: [] } }])).toBe(true)
  const preparing = planReplacements(suite, 'suite:lark', { commandOwners: () => [{ ...row('feishu-tools', 'manual'), stage: 'preparing' }] }, { suiteReplaceable: () => [] })
  expect(replacementBusy(preparing, [])).toBe(true)
})

it('never takes over a manual row another owner manages', () => {
  const plan = planReplacements(suite, 'suite:lark', { commandOwners: () => [row('mcp-own', 'manual', 'mcp:service')] }, { suiteReplaceable: () => [] })
  expect(plan).toMatchObject({ dependencies: [], conflicts: ['mcp-own'] })
})
