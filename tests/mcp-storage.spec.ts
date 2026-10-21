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

it('lets the platform own shared-call deadlines without changing remote or member client deadlines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-deadline-'))
  try {
    const { executionLimits, DEFAULT_EXECUTION_LIMITS } = await import('../src/domain/execution-control.js')
    const longest = executionLimits({ ...DEFAULT_EXECUTION_LIMITS, timeoutSeconds: 3600 })
    const config = { dataRoot: root, command: '/unused', args: [], defaultModel: { provider: 'deepseek-official' as const, model: 'test', upstream: { baseUrl: 'https://model.example.test' } } }
    const service = { name: 'p-shared', generation: 1, description: '', url: '', run: { location: 'shared' as const, command: 'node', args: ['server.mjs'], env: [], prepareCommand: '' } }
    const member = { ...service, name: 'p-member', run: { ...service.run, location: 'member' as const }, prepared: { directory: '/fixture/prepared' } }
    await new FileMcpProjection(config).synchronize([{ username: 'member', spaceId: 'first', services: [service, member, { name: 'p-remote', generation: 1, description: '', url: 'https://example.test/mcp' }] }])
    const entries = JSON.parse(await readFile(join(root, 'mcp', 'members', 'first', 'entries.json'), 'utf8'))
    // The official client's 60-second default would cancel a silent call before
    // even the platform's default 120-second deadline. Its safety ceiling must
    // allow every supported platform deadline to report its own result first.
    expect(entries[0].config.toolCallTimeoutMs).toBeGreaterThan(longest.timeoutSeconds * 1000)
    expect(entries[0].config.toolCallTimeoutMs).toBeLessThanOrEqual(longest.timeoutSeconds * 1000 + 30000)
    expect(entries[1].config.toolCallTimeoutMs).toBeUndefined()
    expect(entries[2].config.toolCallTimeoutMs).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('changes its cheap authorization version for grant-only and preference-only commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-version-'))
  try {
    const store = new FileMcpStore(join(root, 'library.json'))
    const initial = store.version()
    store.write({ services: [], grants: { team: [] }, revision: 0 })
    const granted = store.version(); expect(granted).not.toBe(initial)
    store.write({ services: [], grants: { team: [] }, preferences: { space: { 'p-docs': false } }, revision: 0 })
    expect(store.version()).not.toBe(granted)
    expect(store.read().revision).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
