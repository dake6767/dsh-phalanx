import { randomUUID } from 'node:crypto'
import type { ContributionAdoption } from '../../src/ports/member-contributions.js'
import type { ContributionPersistence } from '../../src/ports/contribution-persistence.js'
import type { ContributionRecord } from '../../src/ports/contribution-rows.js'
import type { ContributionSetup, MemberContribution } from '../../src/domain/member-contribution.js'
import type { LibrarySkill } from '../../src/domain/skill-library.js'
import type { LibraryPlugin } from '../../src/domain/plugin-library.js'
import { BusinessRuleError } from '../../src/domain/business-error.js'

/** Controller-only rows and call recording. Cross-domain atomicity is tested on real PostgreSQL. */
export function memoryContributions(
  rows = new Map<string, MemberContribution>(),
  hooks: {
    skill?: (skill: LibrarySkill, row: MemberContribution, setup?: ContributionSetup) => Promise<void>
    plugin?: (plugin: LibraryPlugin, row: MemberContribution, setup?: ContributionSetup) => Promise<void>
  } = {},
) {
  const versions = new Map<string, { source: MemberContribution; revision: string }>(),
    adoptions: { kind: 'skill' | 'plugin'; row: MemberContribution; setup: ContributionSetup | undefined }[] = []
  const changed = () => new BusinessRuleError('conflict', 'This contribution changed.', 'contribution-unavailable')
  const record = (id: string): ContributionRecord | undefined => {
    const row = rows.get(id)
    if (!row) return undefined
    let version = versions.get(id)
    if (version?.source !== row) {
      version = { source: row, revision: randomUUID() }
      versions.set(id, version)
    }
    return { row: structuredClone(row), revision: version!.revision }
  }
  const save = (row: MemberContribution, expected = 'none') => {
    if ((record(row.id)?.revision ?? 'none') !== expected) throw changed()
    const copy = structuredClone(row)
    rows.set(row.id, copy)
    versions.set(row.id, { source: copy, revision: randomUUID() })
  }
  const check = (input: ContributionRecord) => {
    const current = record(input.row.id)
    if (!current || current.revision !== input.revision) throw changed()
    return current.row
  }
  const list = () => [...rows.values()].map(row => structuredClone(row))
  const adopt = (input: ContributionRecord, setup: ContributionSetup | undefined, updatedAt: number) => {
    const row = check(input)
    if (row.status !== 'pending') throw changed()
    const updates = list().filter(other => other.status === 'pending' && (other.kind ?? 'skill') === (row.kind ?? 'skill') && other.name === row.name)
    // Publish touched controller rows synchronously; this fixture does not model library/configuration facts.
    for (const other of updates)
      save(
        other.id === row.id
          ? { ...other, status: 'adopted', updatedAt }
          : { ...other, status: 'declined', updatedAt, reason: 'Another contribution with this name was adopted.' },
        record(other.id)!.revision,
      )
    adoptions.push({ kind: row.kind ?? 'skill', row, setup: structuredClone(setup) })
  }
  const persistence: ContributionPersistence = {
    rows: {
      get: async id => record(id),
      list: async () => [...rows.keys()].map(id => record(id)!),
      save: async (row, expected) => save(row, expected),
      lockName: async () => {},
      lock: async (id, revision) => check({ row: rows.get(id)!, revision }),
      remove: async (id, revision) => {
        check({ row: rows.get(id)!, revision })
        rows.delete(id)
        versions.delete(id)
      },
    },
    actions: {
      replay: async (_actor, input) => {
        if (record(input.row.id)?.row.status !== 'adopted' || record(input.row.id)?.row.revision !== input.row.revision) throw changed()
      },
      submit: async (actor, proposed) => {
        const pending = [...rows.keys()]
            .map(id => record(id)!)
            .filter(value => value.row.status === 'pending' && value.row.contributor.spaceId === actor.spaceId),
          previous = pending.find(value => (value.row.kind ?? 'skill') === (proposed.kind ?? 'skill') && value.row.name === proposed.name)
        if (!previous && pending.length >= 20) throw new BusinessRuleError('conflict', 'The pending limit is 20.', 'contribution-limit')
        const row = { ...proposed, id: previous?.row.id ?? proposed.id }
        save(row, previous?.revision)
        return structuredClone(row)
      },
      withdraw: async (_actor, input, updatedAt) => save({ ...check(input), status: 'withdrawn', updatedAt }, input.revision),
      decline: async (_actor, input, reason, updatedAt) => save({ ...check(input), status: 'declined', reason, updatedAt }, input.revision),
      remove: async input => {
        check(input)
        rows.delete(input.row.id)
        versions.delete(input.row.id)
      },
      skill: async (_actor, input, skill, setup, updatedAt) => {
        await hooks.skill?.(skill, input.row, setup)
        adopt(input, setup, updatedAt)
      },
      plugin: async (_actor, input, plugin, setup, updatedAt, committed) => {
        await hooks.plugin?.(plugin, input.row, setup)
        adopt(input, setup, updatedAt)
        committed()
      },
    },
  }
  return Object.assign(persistence, { list, adoptions })
}
export function fakeContributionLibrary(onConfirm = () => {}): ContributionAdoption {
  return {
    upload: async () => ({
      token: 'preview',
      name: 'team-guide',
      description: 'Guide',
      markdown: '# Guide',
      files: ['SKILL.md'],
      replacing: false,
      revision: 'impact',
      managedMembers: 0,
      selectedMembers: 0,
    }),
    confirm: async (_actor, _token, _revision, contribution) => {
      const row = {
        name: 'team-guide',
        description: 'Guide',
        hash: 'artifact',
        importedAt: 0,
        published: false,
        ...(contribution ? { contributionReceipt: { id: contribution.id, revision: contribution.revision } } : {}),
      }
      await contribution?.commit?.(row)
      onConfirm()
      contribution?.committed()
      return { ...row, managedMembers: 0, selectedMembers: 0 }
    },
  }
}
