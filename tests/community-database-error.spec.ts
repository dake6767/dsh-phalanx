import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { PlatformDatabaseError } from '../src/domain/platform-database.js'
import { handleCommunityFailure } from '../src/inbound/community-errors.js'
import { listen } from '../src/inbound/public-server.js'

it('reports database failure safely even before ownership-loss shutdown runs', async () => {
  const server = createServer((_request, response) => {
    handleCommunityFailure(response, new PlatformDatabaseError('query-failed', 'fictional-sensitive-connection'), true)
  })
  await listen(server, 0, '127.0.0.1')
  const address = server.address() as { port: number }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/session`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'platform-database-unavailable',
      error: 'Platform database is temporarily unavailable. Check the database service and connection settings.',
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})
