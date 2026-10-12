import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileMcpStore } from '../src/adapters/mcp-store.js'
import { FileMcpProjection } from '../src/adapters/mcp-projection.js'
it('persists library/grants together and projects only per-member names and gateway access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-state-'))
  try {
    const path = join(root, 'library.json'), store = new FileMcpStore(path)
    const services = [{ name: 'p-docs', generation: 1, description: 'Team docs', url: 'https://private-upstream.example.test/mcp' }]
    store.write({ services, grants: { team: ['p-docs'] } })
    expect(new FileMcpStore(path).read()).toEqual({ services, grants: { team: ['p-docs'] } })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const config = { dataRoot: root, command: '/unused', args: [], defaultModel: { provider: 'deepseek-official' as const, model: 'test', upstream: { baseUrl: 'https://model.example.test' } }, container: { runtime: 'podman' as const, image: 'fixture', internalPort: 4180, gatewayPort: 3081 } }
    const projection = new FileMcpProjection(config)
    await projection.synchronize([{ username: 'member', spaceId: 'first', services }, { username: 'other', spaceId: 'second', services: [] }])
    const read = (id: string) => readFile(join(root, 'mcp', 'members', id, 'entries.json'), 'utf8')
    const contents = await read('first')
    expect(contents).toContain('/mcp/p-docs'); expect(contents).not.toContain('private-upstream'); expect(contents).not.toContain('Team docs')
    expect(JSON.parse(await read('second'))).toEqual([])
    await projection.synchronize([{ username: 'member', spaceId: 'first', services: [] }])
    expect(JSON.parse(await read('first'))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
