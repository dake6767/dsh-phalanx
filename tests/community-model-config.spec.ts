import { describe, expect, it } from 'vitest'
import { loadCommunityConfig } from '../src/adapters/community-env-config.js'

const base = { DSH_PHALANX_SESSION_SECRET: 'community-config-session-secret-at-least-32-bytes',
  DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official', DSH_PHALANX_ALLOWED_MODEL: 'deepseek-chat',
  DSH_PHALANX_RUNTIME_COMMAND: 'node', DSH_PHALANX_RUNTIME_ARGS_JSON: '[]',
  DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'https://api.deepseek.com' }

describe('community static default model configuration', () => {
  it('accepts a deployer credential only in platform configuration', () => {
    const config = loadCommunityConfig({ ...base, DSH_PHALANX_MODEL_UPSTREAM_API_KEY: 'fixture-shared-provider-secret' })
    expect(config.modelGateway?.upstreamApiKey).toBe('fixture-shared-provider-secret')
    expect(JSON.stringify(config.runtime)).not.toContain('fixture-shared-provider-secret')
    expect(loadCommunityConfig(base).modelGateway).toBeUndefined()
  })
  it('loads model defaults without an execution-guard patch dependency', () => {
    expect(loadCommunityConfig(base).runtime.defaultModel).toEqual({ provider: 'deepseek-official',
      model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } })
  })

  it('rejects a credential that cannot be placed in an HTTP header without echoing it', () => {
    const secret = 'private-fixture-value\ninjected-header'
    let failure: unknown
    try { loadCommunityConfig({ ...base, DSH_PHALANX_MODEL_UPSTREAM_API_KEY: secret }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Default model upstream credential must be a nonempty HTTP header value')
    expect((failure as Error).message).not.toContain('private-fixture-value')
  })

  it('keeps declared public host aliases in platform configuration and rejects invalid addresses', () => {
    const config = loadCommunityConfig({ ...base, DSH_PHALANX_HOST_PUBLIC_ADDRESSES: '8.8.8.8, 1.1.1.1' })
    expect(config.network?.hostPublicAddresses).toEqual(['8.8.8.8', '1.1.1.1'])
    expect(config.runtime.environment ?? {}).not.toHaveProperty('DSH_PHALANX_HOST_PUBLIC_ADDRESSES')
    expect(() => loadCommunityConfig({ ...base, DSH_PHALANX_HOST_PUBLIC_ADDRESSES: '10.0.0.1' })).toThrow('Host public addresses must be public IPv4 literals')
  })
})
