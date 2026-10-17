import { expect, it } from 'vitest'
import { credentialsFor, ExecutionSuiteKind, SkillPackSuiteKind, SkillSuiteKind } from '../src/use-cases/suite-entry-kinds.js'
import type { SuiteCatalogExecutionItem, SuiteCatalogSkillItem } from '../src/domain/suite-catalog.js'

const text = { en: 'key', 'zh-CN': '密钥' }
const execution: SuiteCatalogExecutionItem = { kind: 'execution', skill: 'one', runtimeDependency: 'cli', delegated: [{ command: 'cli', blocked: ['auth'] }], variables: [{ name: 'KEY', purpose: text }] }

it('keeps only the credential values an execution item declares', () => {
  expect(credentialsFor(execution, { KEY: 'value', OTHER: 'ignored' })).toEqual({ KEY: 'value' })
})

it('plans each kind for the preview without touching the library', () => {
  const skill: SuiteCatalogSkillItem = { kind: 'skill', source: { type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40), path: 'skills' }, names: ['one', 'two'] }
  const unused = () => { throw new Error('unused') }
  const skills = new SkillSuiteKind({ prepareSuiteImport: unused, suiteSkillConflicts: unused, commitSuiteSkills: unused, discardSuiteImport: unused, removeSuiteSkills: unused, detachSuiteSkill: unused }, () => new AbortController().signal,
    { commitSuitePack: unused, removeSuitePack: unused, detachSuitePack: unused, applySuiteOptions: unused, suiteImpact: unused, manualPacksContaining: () => ['manual'] })
  expect(skills.plan(skill)).toEqual({ name: '2 skills', detail: 'o/r @ bbbbbbb' })
  expect(skills.references({ kind: 'skill', name: 'one' })).toEqual([{ kind: 'skill-pack', name: 'manual' }])
  expect(new ExecutionSuiteKind(undefined).available()).toBe(false)
  expect(new ExecutionSuiteKind(undefined).plan(execution)).toEqual({ name: 'cli', detail: 'KEY' })
  expect(new SkillPackSuiteKind({ commitSuitePack: unused, removeSuitePack: unused, detachSuitePack: unused, applySuiteOptions: unused, suiteImpact: unused, manualPacksContaining: unused })
    .plan({ kind: 'skill-pack', name: 'pack', description: 'd', note: 'n', skills: ['one'] })).toEqual({ name: 'pack', detail: '1 skills' })
})
