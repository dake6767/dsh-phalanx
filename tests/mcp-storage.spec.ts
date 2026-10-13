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
    expect(new FileMcpStore(path).read()).toEqual({ revision: 1, services, grants: { team: ['p-docs'] } })
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
it('preserves adopted preset state and retired import identities across durable reloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-store-'))
  try {
    const path = join(root, 'library.json'), store = new FileMcpStore(path)
    store.write({ services: [{ name: 'p-map', generation: 1, description: 'Amap', url: 'https://mcp.amap.com/mcp', credential: 'fixture-secret', catalogRequestId: 'request-0000000001', catalog: { id: 'amap', version: '1', status: 'failed' } }], grants: {}, catalogRequests: ['request-0000000001', 'removed-000000001'] })
    const restored = new FileMcpStore(path).read()
    expect(restored.services[0]).toMatchObject({ catalogRequestId: 'request-0000000001', catalog: { id: 'amap', version: '1', status: 'failed' } })
    expect(restored.catalogRequests).toEqual(['request-0000000001', 'removed-000000001'])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reloads a private candidate and its operation receipt without replacing the active service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-update-store-'))
  try {
    const path = join(root, 'library.json'), store = new FileMcpStore(path)
    const candidate = { name: 'p-update-2', preparationName: 'p-update-2', generation: 2, description: 'Next', url: 'https://new.example.test', credential: 'fixture-private', catalog: { id: 'amap', version: '2', status: 'testing' as const } }
    store.write({ revision: 2, services: [{ name: 'p-map', generation: 1, description: 'Current', url: 'https://old.example.test', catalog: { id: 'amap', version: '1', status: 'ready' }, catalogUpdate: { name: candidate.name, requestId: 'durable-update-request', version: '2', baseGeneration: 1, actor: { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }, status: 'testing', candidate } }], grants: { members: ['p-map'] }, catalogRequests: ['durable-update-request'] })
    expect(new FileMcpStore(path).read()).toMatchObject({ revision: 2, services: [{ url: 'https://old.example.test', catalogUpdate: { candidate } }], grants: { members: ['p-map'] }, catalogRequests: ['durable-update-request'] })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})
