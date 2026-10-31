import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { UnixCommunitySystemUpdate } from '../src/adapters/community-system-update.js'
import { CommunitySystemUpdateUnavailableError } from '../src/ports/community-system-update.js'
import { BusinessRuleError } from '../src/domain/business-error.js'

let server: Server | undefined
let root: string | undefined
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>(resolve => {
    if (server) server.close(() => resolve())
    else resolve()
  })
  if (root) await rm(root, { recursive: true, force: true })
})
it('uses the closed Unix HTTP protocol and treats a lost acknowledgement as unavailable rather than retrying', async () => {
  root = await mkdtemp(join(tmpdir(), 'update-unix-'))
  const path = join(root, 'control.sock')
  const received: unknown[] = []
  server = createServer(async (request, response) => {
    expect(request.url).toBe('/control')
    expect(request.method).toBe('POST')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action: string }
    received.push(input)
    if (input.action === 'apply') {
      response.destroy()
      return
    }
    if (input.action === 'prepare') {
      response.writeHead(409)
      response.end(JSON.stringify({ error: 'Another installer is running', errorCode: 'operation.conflict' }))
      return
    }
    response.writeHead(200)
    if (input.action === 'check') {
      response.end(
        JSON.stringify({
          check: {
            status: 'available',
            checkedAt: '2026-10-29T00:00:00Z',
            version: 'v0.1.27',
            manifestSha256: 'a'.repeat(64),
            releaseNotes: '',
            outcomeCode: 'update.available',
            versions: [{ version: 'v0.1.27', outcomeCode: 'update.available' }],
          },
        }),
      )
      return
    }
    response.end(JSON.stringify({ currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation: null, events: [] }))
  })
  await new Promise<void>(resolve => server!.listen(path, resolve))
  const updates = new UnixCommunitySystemUpdate(path)
  expect(await updates.status()).toMatchObject({ runningVersion: 'v0.1.2' })
  expect(await updates.check()).toMatchObject({
    check: { outcomeCode: 'update.available', versions: [{ version: 'v0.1.27', outcomeCode: 'update.available' }] },
  })
  const refused = await updates.prepare('v0.1.3', 'a'.repeat(64)).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(BusinessRuleError)
  expect(refused).toMatchObject({ code: 'update-request-refused', params: { systemUpdateErrorCode: 'operation.conflict' } })
  await expect(updates.apply('12345678-1234-1234-1234-123456789abc')).rejects.toBeInstanceOf(CommunitySystemUpdateUnavailableError)
  expect(received).toEqual([
    { action: 'status' },
    { action: 'check' },
    { action: 'prepare', version: 'v0.1.3', manifestSha256: 'a'.repeat(64) },
    { action: 'apply', operation: '12345678-1234-1234-1234-123456789abc' },
  ])
})
