import { expect, it } from 'vitest'
import { CommunitySystemStatus } from '../src/use-cases/community-system-status.js'

it('admits only fresh administrators and binds backup confirmation to the displayed fingerprint', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let account = { ...actor, admin: true, disabled: false, email: '', groupId: 'admins', createdAt: 0, updatedAt: 0 }
  const fingerprint = `sha256:${'a'.repeat(64)}`
  const calls: unknown[] = []
  const status = {
    database: { kind: 'builtin' as const, address: 'localhost:5432/platform', serverVersion: '17.11', state: 'connected' as const },
    masterKey: { fingerprint, backup: null },
  }
  const service = new CommunitySystemStatus(
    { get: async () => account },
    {
      read: async () => {
        calls.push('read')
        return status
      },
      confirmBackup: async (fp, by) => {
        calls.push([fp, by])
        return status
      },
    },
  )
  expect(await service.view(actor)).toEqual(status)
  expect(await service.confirmBackup(actor, fingerprint)).toEqual(status)
  account = { ...account, admin: false }
  await expect(service.view(actor)).rejects.toThrow('Administrator')
  await expect(service.confirmBackup(actor, fingerprint)).rejects.toThrow('Administrator')
  account = { ...account, admin: true, sessionEpoch: 1 }
  await expect(service.view(actor)).rejects.toThrow('Sign in')
  account = { ...account, sessionEpoch: 0, disabled: true }
  await expect(service.confirmBackup(actor, fingerprint)).rejects.toThrow('Sign in')
  account = { ...account, disabled: false }
  await expect(service.confirmBackup(actor, 'arbitrary')).rejects.toThrow('fingerprint')
  expect(calls).toEqual(['read', [fingerprint, { username: actor.username, spaceId: actor.spaceId }]])
})
