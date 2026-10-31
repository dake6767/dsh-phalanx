import { retainedArtifactCarriers } from './fixtures/retained-artifacts.js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { MODEL_GATEWAY_PATH } from '../src/dsh/model-protocol.js'
import { StablePublicEntry } from '../src/inbound/stable-public-entry.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'

async function expectMaintenancePage(origin: string, path: string, language: string, text: string): Promise<void> {
  const response = await fetch(origin + path, { redirect: 'manual', headers: { 'accept-language': language, cookie: 'dsh-phalanx.lang=en' } })
  expect(response.status).toBe(503)
  expect(response.headers.get('retry-after')).toBe('3')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-type')).toContain('text/html')
  const body = await response.text()
  expect(body).toContain('data-platform-maintenance')
  expect(body).toContain(text)
  expect(body).toContain('/readyz')
}

it('preserves every recoverable artifact family on validation startup and resumes eligible collection on normal startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'community-artifact-maintenance-')),
    marker = join(root, 'maintenance'),
    dataRoot = join(root, 'data'),
    config = {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'fixture-session-secret-at-least-32-characters',
      maintenanceFile: marker,
      runtime: {
        command: '/nonexistent-dsh-command',
        args: [],
        dataRoot,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
      },
    },
    carriers = retainedArtifactCarriers
  let application = createCommunityApplication(config)
  try {
    await application.start()
    await application.stop()
    for (const carrier of carriers) {
      await mkdir(join(dataRoot, carrier, '..'), { recursive: true })
      await writeFile(join(dataRoot, carrier), 'retained old artifact')
    }
    await writeFile(marker, 'validation')
    application = createCommunityApplication(config)
    const origin = await application.start()
    expect((await fetch(origin + '/readyz')).status).toBe(200)
    await expectMaintenancePage(origin, '/login', 'en', 'System upgrade in progress')
    await expectMaintenancePage(origin, '/login', 'en;q=0.3,zh-CN;q=0.9', '系统升级中')
    for (const carrier of carriers) expect(await readFile(join(dataRoot, carrier), 'utf8')).toBe('retained old artifact')
    await rm(marker)
    await application.stop()
    application = createCommunityApplication(config)
    await application.start()
    // Member projection reclamation also waits for the existing records-ready barrier.
    // Its later removal is covered at the distribution seam with reconciled membership.
    const protectedProjection = 'skills/members/retired/generation-old/value'
    expect(await readFile(join(dataRoot, protectedProjection), 'utf8')).toBe('retained old artifact')
    expect(carriers.filter(carrier => carrier !== protectedProjection && existsSync(join(dataRoot, carrier)))).toEqual([])
  } finally {
    await application.stop()
    await removeCommunityFixture(root)
  }
})

it('keeps HTTP, model and WebSocket work closed during validation while readiness can be verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'community-maintenance-')),
    marker = join(root, 'maintenance'),
    entry = new StablePublicEntry({ host: '127.0.0.1', port: 0 }, { closed: () => existsSync(marker) })
  await entry.start()
  const application = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'fixture-session-secret-at-least-32-characters',
      maintenanceFile: marker,
      runtime: {
        command: '/nonexistent-dsh-command',
        args: [],
        dataRoot: join(root, 'data'),
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
      },
    },
    { publicEntry: entry },
  )
  try {
    const origin = await application.start()
    expect((await fetch(`${origin}/login`)).status).toBe(200)
    await writeFile(marker, 'Upgrade validation\n')
    for (const path of ['/login', '/bootstrap', '/enter', '/admin/api/accounts']) {
      await expectMaintenancePage(origin, path, 'zh-CN', '系统升级中')
      await expectMaintenancePage(origin, path, 'zh-CN;q=0,en;q=1', 'System upgrade in progress')
    }
    expect((await fetch(origin + MODEL_GATEWAY_PATH, { method: 'POST', body: '{}' })).status).toBe(503)
    expect((await fetch(`${origin}/readyz`)).status).toBe(200)
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/native')
      socket.once('error', reject)
      socket.once('unexpected-response', (_, response) => {
        response.resume()
        socket.terminate()
        resolve(response.statusCode!)
      })
    })
    expect(status).toBe(503)
    await unlink(marker)
    expect((await fetch(`${origin}/login`)).status).toBe(200)
  } finally {
    await application.stop()
    await entry.stop()
    await removeCommunityFixture(root)
  }
})
