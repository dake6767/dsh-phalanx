import { postgresContributionService } from './fixtures/postgres-contribution-service.js'
import { expect, it } from 'vitest'
import { assertSkillContributionSetup, planSkillContributionDependencies } from '../src/use-cases/skill-contribution-policy.js'

it('keeps saved dependency references and binds only commands supplied by a prepared version', () => {
  const plan = planSkillContributionDependencies(
    { name: 'writing', description: 'Writes', hash: 'fixture', importedAt: 0, published: false, runtimeDependencies: ['retained'] },
    [{ name: 'tools', current: { id: 'v1', bytes: 1, commands: ['rd-tool'], isolated: true } }],
    {
      purpose: 'Writes',
      requiredCommands: [
        { name: 'rd-tool', purpose: 'Render', installation: 'Install tools' },
        { name: 'other', purpose: 'Optional tool', installation: 'Install separately' },
      ],
    },
  )
  expect(plan.references).toEqual(['retained', 'tools'])
  expect(plan.requirements).toEqual([
    expect.objectContaining({ name: 'rd-tool', dependency: 'tools', added: true }),
    { name: 'other', purpose: 'Optional tool', installation: 'Install separately', added: true },
  ])
})

it('rejects unknown distribution effects and duplicate group decisions before adoption', () => {
  expect(() => assertSkillContributionSetup(Object.assign({ published: true }, { unexpected: true }))).toThrow(
    expect.objectContaining({ code: 'contribution-invalid' }),
  )
  expect(() =>
    assertSkillContributionSetup({
      groups: [
        { id: 'team', revision: 'one' },
        { id: 'team', revision: 'two' },
      ],
    }),
  ).toThrow(expect.objectContaining({ code: 'contribution-invalid' }))
  expect(() => assertSkillContributionSetup({ published: false, groups: [{ id: 'team', revision: 'one' }] })).not.toThrow()
})

it('retires selected access when atomic contribution adoption unpublishes a skill and does not revive it on republication', async () => {
  const f = await postgresContributionService()
  try {
    await f.storage.library.save({ name: 'guide', description: 'Guide', hash: 'b'.repeat(64), published: true, importedAt: 0 })
    await f.library.select(f.member, 'guide', true)
    expect(await f.storage.selections.get(f.member.spaceId)).toEqual(['guide'])
    const row = await f.submit(),
      review = await f.service.review(f.actor, row.id, row.revision)
    await f.service.decide(f.actor, row.id, { action: 'adopt', revision: row.revision, token: review.token, setup: { published: false } })
    expect(await f.storage.selections.get(f.member.spaceId)).toEqual([])
    await f.library.publish(f.actor, 'guide', true, (await f.library.detail(f.actor, 'guide')).revision)
    expect(await f.storage.selections.get(f.member.spaceId)).toEqual([])
    expect((await f.library.market(f.member)).skills[0]?.source).toBeNull()
  } finally {
    await f.close()
  }
})
