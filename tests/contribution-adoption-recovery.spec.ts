import { seedExecutionOwners } from './fixtures/execution-owners.js'
import { postgresContributionService } from './fixtures/postgres-contribution-service.js'
import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgresExecutionConfigurations } from '../src/adapters/postgres-execution-configurations.js'
import { openTestDatabase } from './support/community-application.js'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'

it('commits adoption with a warning when its confirmed empty group disappears and keeps library metadata redacted', async () => {
  const f = await postgresContributionService('apiKey = "personal-key"')
  try {
    const group = await f.accounts.createGroup('Temporary'),
      row = await f.submit(),
      review = await f.service.review(f.actor, row.id, row.revision),
      choice = review.groups!.find(value => value.group.id === group.id)!
    f.fault.beforeConfirm = () => f.accounts.deleteGroup(group.id)
    await f.service.decide(f.actor, row.id, {
      action: 'adopt',
      revision: row.revision,
      token: review.token,
      setup: { groups: [{ id: group.id, revision: choice.revision }] },
    })
    expect((await f.persistence.rows.get(row.id))?.row).toMatchObject({ status: 'adopted', reason: expect.stringContaining('group was removed') })
    expect(await f.storage.grants.get(group.id)).toEqual([])
    expect(JSON.stringify(await f.library.detail(f.actor, row.name))).not.toContain('personal-key')
  } finally {
    await f.close()
  }
})

it('retains preparation approval and idempotent configuration ownership across a platform restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-config-recovery-'))
  const database = await openTestDatabase(root)
  const stores: PostgresExecutionConfigurations[] = []
  const open = async () => {
    await seedExecutionOwners(database, ['skill:guide'])
    const store = new PostgresExecutionConfigurations(database)
    stores.push(store)
    await store.initialize()
    return store
  }
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const accounts = { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }
  const make = async () => new ExecutionAdministration(accounts, { get: id => ({ id, version: 'v1' }), owns: async () => true }, await open(), async () => {})
  const row = {
    name: 'guide',
    description: 'Guide',
    hash: 'artifact',
    markdown: '# Guide',
    files: ['SKILL.md'],
    id: 'contribution',
    revision: 'content-revision',
    contributor: actor,
    declaration: { purpose: 'Share guide' },
    submittedAt: 0,
    updatedAt: 0,
    status: 'pending' as const,
  }
  const setup = { enabled: true, commands: [{ command: 'guide', blocked: [] }], variables: [{ name: 'KEY', secret: true, value: 'old-secret' }] }
  try {
    await (await make()).adoptContribution(row, setup)
    const restarted = await make()
    expect((await restarted.view(actor, 'skill:guide')).awaitingPreparation).toBe(true)
    await restarted.save(actor, 'skill:guide', { ...setup, variables: [{ name: 'KEY', secret: true, value: 'new-secret' }] })
    await (await make()).adoptContribution(row, setup)
    expect((await (await open()).get('skill:guide'))!.variables[0]!.value).toBe('new-secret')
  } finally {
    await Promise.all(stores.map(store => store.close()))
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('distinguishes new contributions with identical bytes and never replays an older committed request after restart', async () => {
  const f = await postgresContributionService()
  try {
    const group = (await f.accounts.listGroups()).find(value => value.kind === 'ordinary')!
    const adopt = async () => {
      const row = await f.submit(),
        review = await f.service.review(f.actor, row.id, row.revision),
        choice = review.groups!.find(value => value.group.id === group.id)!
      await f.service.decide(f.actor, row.id, {
        action: 'adopt',
        revision: row.revision,
        token: review.token,
        setup: { published: true, groups: [{ id: group.id, revision: choice.revision }] },
      })
      return row
    }
    const first = await adopt()
    await f.storage.grants.set(group.id, [])
    await f.storage.library.save({ ...(await f.storage.library.list())[0]!, published: false })
    const second = await adopt()
    expect(second.id).not.toBe(first.id)
    expect(second.hash).toBe(first.hash)
    expect((await f.storage.library.list())[0]?.contributionReceipt).toEqual({ id: second.id, revision: second.revision })
    expect(await f.storage.grants.get(group.id)).toEqual([first.name])
    await f.storage.grants.set(group.id, [])
    await f.storage.library.save({ ...(await f.storage.library.list())[0]!, published: false })
    await f.restart()
    const before = await f.storage.library.list()
    await f.service.decide(f.actor, first.id, { action: 'adopt', revision: first.revision, token: 'expired-token', setup: { published: true } })
    expect(await f.storage.library.list()).toEqual(before)
    expect(await f.storage.grants.get(group.id)).toEqual([])
    expect((await f.persistence.rows.get(first.id))?.row.status).toBe('adopted')
    expect((await f.persistence.rows.get(second.id))?.row.status).toBe('adopted')
  } finally {
    await f.close()
  }
})

it('retains newer execution settings and a durable warning when configuration changes between review and the atomic commit', async () => {
  const f = await postgresContributionService()
  try {
    await f.storage.library.save({ name: 'guide', description: 'Original', hash: 'b'.repeat(64), published: false, importedAt: 0 })
    const configuration = {
      enabled: true,
      commands: [{ command: 'guide', blocked: [] }],
      variables: [{ name: 'KEY', secret: true, value: 'fictional-original' }],
    }
    await f.execution.save('skill:guide', configuration)
    const row = await f.submit({
        purpose: 'Update',
        execution: { commands: [{ command: 'guide', blocked: [] }], variables: [{ name: 'KEY', purpose: 'Authenticate', application: 'Console' }] },
      }),
      review = await f.service.review(f.actor, row.id, row.revision)
    f.fault.beforeConfirm = async () => {
      await f.execution.save('skill:guide', {
        ...(await f.execution.get('skill:guide'))!,
        variables: [{ name: 'KEY', secret: true, value: 'fictional-newer' }],
      })
    }
    await f.service.decide(f.actor, row.id, {
      action: 'adopt',
      revision: row.revision,
      token: review.token,
      setup: { published: true, execution: { ...configuration, variables: [{ name: 'KEY', secret: true, value: 'fictional-submitted' }] } },
    })
    expect((await f.execution.get('skill:guide'))?.variables[0]?.value).toBe('fictional-newer')
    expect((await f.persistence.rows.get(row.id))?.row).toMatchObject({
      status: 'adopted',
      reason: expect.stringContaining('newer administrator configuration was retained'),
    })
    expect((await f.storage.library.list())[0]).toMatchObject({ published: false, contributionReceipt: { id: row.id, revision: row.revision } })
  } finally {
    await f.close()
  }
})
