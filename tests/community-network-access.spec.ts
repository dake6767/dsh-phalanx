import { describe, expect, it } from 'vitest'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { CommunityNetworkAccess } from '../src/use-cases/community-network-access.js'

describe('community public network access', () => {
  function fixture(resolve: (hostname: string) => Promise<readonly string[]> = async () => ['1.1.1.1']) {
    let disabled = false
    const authorization = new CommunityModelAuthorization({ getState: () => ({ username: 'alice', spaceId: 'space-alice', disabled, admin: false, sessionEpoch: 0 }) },
      { resolve: token => token === 'alice-token' ? { username: 'alice', spaceId: 'space-alice' } : undefined })
    const access = new CommunityNetworkAccess(authorization, { resolve, hostAddresses: () => ['8.8.8.8'] })
    return { access, disable: () => { disabled = true } }
  }
  it('allows an authenticated public upstream on a custom TCP port with its resolved address pinned', async () => {
    const { access } = fixture()
    expect(await access.authorize({ hostname: 'own.example', port: 8443 }, 'alice-token')).toMatchObject({ status: 200, grant: { username: 'alice', address: '1.1.1.1', hostname: 'own.example', port: 8443 } })
    expect((await access.authorize({ hostname: 'own.example', port: 8443 }, undefined)).status).toBe(407)
  })
  it('pins public IPv4 from a dual-stack DNS answer without opening IPv6 access', async () => {
    const { access } = fixture(async () => ['2606:4700:4700::1111', '1.1.1.1'])
    expect(await access.authorize({ hostname: 'dual.example', port: 443 }, 'alice-token')).toMatchObject({ status: 200, grant: { address: '1.1.1.1' } })
  })
  it('denies host, private, metadata, reserved, IPv6 and mixed resolution targets', async () => {
    for (const addresses of [['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['100.100.100.200'], ['192.168.1.1'], ['8.8.8.8'], ['203.0.113.1'], ['::1'], ['1.1.1.1', '127.0.0.1'], []]) {
      const { access } = fixture(async () => addresses)
      expect((await access.authorize({ hostname: 'target.example', port: 443 }, 'alice-token')).status).toBe(403)
    }
  })
  it('rechecks fresh account eligibility after DNS and on an existing grant', async () => {
    let resolved!: (addresses: readonly string[]) => void
    const waiting = new Promise<readonly string[]>(resolve => { resolved = resolve })
    const { access, disable } = fixture(async () => waiting)
    const pending = access.authorize({ hostname: 'own.example', port: 443 }, 'alice-token')
    disable(); resolved(['1.1.1.1']); expect((await pending).status).toBe(403)
    const healthy = fixture(); const result = await healthy.access.authorize({ hostname: 'own.example', port: 443 }, 'alice-token')
    if (result.status !== 200) throw new Error('expected public access')
    healthy.disable(); expect(healthy.access.current(result.grant)).toBe(false)
  })
})
