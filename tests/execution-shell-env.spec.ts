import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { prepareCommunityPlatformPlugin } from '../src/adapters/community-platform-plugin.js'

it('registers only current member gateway access through the shipped shell environment plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-shell-env-'))
  vi.stubEnv('DSH_PHALANX_MODEL_GATEWAY_URL', 'http://member-gateway.invalid')
  vi.stubEnv('DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN', 'fixture-member-access')
  vi.stubEnv('MINIMAX_API_KEY', 'fixture-platform-secret')
  let contributor!: { variables: Record<string, unknown>, resolve(): Record<string, string> }
  try {
    await prepareCommunityPlatformPlugin(root, false)
    const rows = JSON.parse(await readFile(join(root, 'platform-plugin/plugins.yml'), 'utf8'))
    const row = rows.find((entry: { id: string }) => entry.id === 'phalanx-execution-shell-environment')
    const plugin = await import(pathToFileURL(row.name).href)
    plugin.apply({ shellEnv: { register: (value: typeof contributor) => { contributor = value } } })
    expect(Object.keys(contributor.variables)).toEqual(['DSH_PHALANX_MODEL_GATEWAY_URL', 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN'])
    expect(contributor.resolve()).toEqual({ DSH_PHALANX_MODEL_GATEWAY_URL: 'http://member-gateway.invalid', DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: 'fixture-member-access' })
    vi.stubEnv('DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN', 'rotated-member-access')
    expect(contributor.resolve().DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN).toBe('rotated-member-access')
    expect(await readFile(row.name, 'utf8')).not.toContain('fixture-member-access')
    expect(Object.values(contributor.resolve())).not.toContain('fixture-platform-secret')
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
