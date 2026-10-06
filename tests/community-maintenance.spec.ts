import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { expect, it } from 'vitest'
import { MODEL_GATEWAY_PATH } from '../src/dsh/model-protocol.js'
import { createCommunityApplication } from '../src/composition/community-application.js'

it('keeps HTTP, model and WebSocket work closed during validation while readiness can be verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'community-maintenance-')), marker = join(root, 'maintenance')
  const application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'fixture-session-secret-at-least-32-characters', maintenanceFile: marker,
    runtime: { command: '/nonexistent-dsh-command', args: [], dataRoot: join(root, 'data'),
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } })
  try {
    const origin = await application.start()
    expect((await fetch(`${origin}/login`)).status).toBe(200)
    await writeFile(marker, 'Upgrade validation\n')
    for (const path of ['/login', '/bootstrap', '/enter', '/admin/api/accounts']) {
      expect((await fetch(origin + path, { redirect: 'manual' })).status).toBe(503)
    }
    expect((await fetch(origin + MODEL_GATEWAY_PATH, { method: 'POST', body: '{}' })).status).toBe(503)
    expect((await fetch(`${origin}/readyz`)).status).toBe(200)
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/native')
      socket.once('error', reject)
      socket.once('unexpected-response', (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!) })
    })
    expect(status).toBe(503)
    await unlink(marker)
    expect((await fetch(`${origin}/login`)).status).toBe(200)
  } finally { await application.stop(); await rm(root, { recursive: true, force: true }) }
})
