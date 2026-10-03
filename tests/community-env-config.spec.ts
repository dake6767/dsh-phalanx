import { describe, expect, it } from 'vitest'
import { loadCommunityConfig } from '../src/adapters/community-env-config.js'

const DEPLOYMENT_BASE = {
  DSH_PHALANX_SESSION_SECRET: 'deployment-session-secret-at-least-32-bytes',
  DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official',
  DSH_PHALANX_ALLOWED_MODEL: 'deepseek-chat',
  DSH_PHALANX_RUNTIME_COMMAND: 'node',
  DSH_PHALANX_RUNTIME_ARGS_JSON: '[]',
  DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'https://api.deepseek.com',
} as const

describe('deployment configuration', () => {
  it('loads deployment settings and an external runtime without embedding local paths', () => {
    const config = loadCommunityConfig({
      DSH_PHALANX_SESSION_SECRET: 'deployment-session-secret-at-least-32-bytes',
      DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official',
      DSH_PHALANX_ALLOWED_MODEL: 'deepseek-flash',
      DSH_PHALANX_RUNTIME_COMMAND: '/opt/dsh/bin/node',
      DSH_PHALANX_RUNTIME_ARGS_JSON: JSON.stringify(['/opt/dsh/apps/cli/lib/bin.js', 'web']),
      DSH_PHALANX_DATA_ROOT: '/var/lib/dsh-phalanx',
      DSH_PHALANX_RUNTIME_ENV_JSON: JSON.stringify({ DEEPSEEK_BASE_URL: 'http://127.0.0.1:7777' }),
      DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'https://api.deepseek.com',
      DSH_PHALANX_RUNTIME_PATCHES_JSON: JSON.stringify(['/etc/dsh-phalanx/web.overlay.yml']),
      DSH_PHALANX_HOST: '127.0.0.1',
      DSH_PHALANX_PORT: '3080',
      DSH_PHALANX_PUBLIC_ORIGIN: 'https://dsh-phalanx.example.test',
    })

    expect(config.listen).toEqual({
      host: '127.0.0.1',
      port: 3080,
      publicOrigin: 'https://dsh-phalanx.example.test',
    })
    expect(config.runtime).toMatchObject({
      command: '/opt/dsh/bin/node',
      args: ['/opt/dsh/apps/cli/lib/bin.js', 'web'],
      dataRoot: '/var/lib/dsh-phalanx',
      environment: { DEEPSEEK_BASE_URL: 'http://127.0.0.1:7777' },
      patches: ['/etc/dsh-phalanx/web.overlay.yml'],
      defaultModel: {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        upstream: { baseUrl: 'https://api.deepseek.com' },
      },
    })
  })

  it('rejects missing secrets and malformed structured values', () => {
    expect(() => loadCommunityConfig({})).toThrow('DSH_PHALANX_SESSION_SECRET')
    expect(() => loadCommunityConfig({
      DSH_PHALANX_SESSION_SECRET: 'deployment-session-secret-at-least-32-bytes',
      DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official',
      DSH_PHALANX_ALLOWED_MODEL: 'deepseek-flash',
      DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'https://api.deepseek.com',
    })).toThrow('DSH_PHALANX_RUNTIME_COMMAND')
    expect(() => loadCommunityConfig({
      DSH_PHALANX_SESSION_SECRET: 'deployment-session-secret-at-least-32-bytes',
      DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official',
      DSH_PHALANX_ALLOWED_MODEL: 'deepseek-flash',
      DSH_PHALANX_RUNTIME_COMMAND: 'node',
      DSH_PHALANX_RUNTIME_ARGS_JSON: 'not-json',
      DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'https://api.deepseek.com',
    })).toThrow('DSH_PHALANX_RUNTIME_ARGS_JSON')
  })

  it('rejects credentials placed in the child process environment', () => {
    expect(() => loadCommunityConfig({
      DSH_PHALANX_SESSION_SECRET: 'deployment-session-secret-at-least-32-bytes',
      DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official',
      DSH_PHALANX_ALLOWED_MODEL: 'deepseek-chat',
      DSH_PHALANX_RUNTIME_COMMAND: 'node',
      DSH_PHALANX_RUNTIME_ARGS_JSON: '[]',
      DSH_PHALANX_RUNTIME_ENV_JSON: JSON.stringify({ DEEPSEEK_API_KEY: 'must-not-enter-process-env' }),
    })).toThrow('keep platform credentials in dsh-phalanx configuration')
  })

  it('applies the 30-minute idle window unless the deployment overrides it', () => {
    expect(loadCommunityConfig(DEPLOYMENT_BASE).idleReclaimSeconds).toBe(1800)
    expect(loadCommunityConfig({
      ...DEPLOYMENT_BASE,
      DSH_PHALANX_IDLE_RECLAIM_SECONDS: '45',
    }).idleReclaimSeconds).toBe(45)
  })

  it('accepts a small idle window for tests and zero to disable automatic reclamation', () => {
    expect(loadCommunityConfig({ ...DEPLOYMENT_BASE, DSH_PHALANX_IDLE_RECLAIM_SECONDS: '4' }).idleReclaimSeconds).toBe(4)
    expect(loadCommunityConfig({ ...DEPLOYMENT_BASE, DSH_PHALANX_IDLE_RECLAIM_SECONDS: '0' }).idleReclaimSeconds).toBe(0)
    expect(() => loadCommunityConfig({ ...DEPLOYMENT_BASE, DSH_PHALANX_IDLE_RECLAIM_SECONDS: '-1' })).toThrow('DSH_PHALANX_IDLE_RECLAIM_SECONDS')
    expect(() => loadCommunityConfig({ ...DEPLOYMENT_BASE, DSH_PHALANX_IDLE_RECLAIM_SECONDS: 'soon' })).toThrow('DSH_PHALANX_IDLE_RECLAIM_SECONDS')
  })

  it('retains a default-closed registration setting and rejects unsupported open registration', () => {
    expect(loadCommunityConfig(DEPLOYMENT_BASE).registration).toEqual({ enabled: false })
    expect(loadCommunityConfig({ ...DEPLOYMENT_BASE, DSH_PHALANX_REGISTRATION_ENABLED: 'false' }).registration).toEqual({ enabled: false })
    expect(() => loadCommunityConfig({ ...DEPLOYMENT_BASE, DSH_PHALANX_REGISTRATION_ENABLED: 'true' })).toThrow('open registration is unavailable in 0.1.0')
    expect(() => loadCommunityConfig({ ...DEPLOYMENT_BASE, DSH_PHALANX_REGISTRATION_ENABLED: 'yes' })).toThrow('DSH_PHALANX_REGISTRATION_ENABLED')
  })
})
