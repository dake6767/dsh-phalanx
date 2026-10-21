import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { HttpDshSession } from '../src/adapters/dsh-session.js'

it('recognizes cookies exchanged for the exact instance and renews admission after a platform sign in', async () => {
  let sequence = 0
  const server = createServer((_request, response) => {
    response.writeHead(303, { location: '/', 'set-cookie': `fixture_session=accepted-${++sequence}; Path=/; HttpOnly` }); response.end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture listener')
    const origin = `http://127.0.0.1:${address.port}`
    const instance = { userId: 'member', processId: 100, origin, launchUrl: origin + '/?token=fictional' }
    const sessions = new HttpDshSession()
    expect(sessions.hasSession(instance, 'fixture_session=forged')).toBe(false)
    await sessions.exchangeLaunchToken(instance, new URL(origin))
    expect(sessions.hasSession(instance, 'other=value; fixture_session=accepted-1')).toBe(true)
    expect(sessions.hasSession({ ...instance, processId: 101 }, 'fixture_session=accepted-1')).toBe(false)
    expect(sessions.hasSession(instance, undefined)).toBe(false)
    await sessions.exchangeLaunchToken(instance, new URL(origin))
    expect(sessions.hasSession(instance, 'fixture_session=accepted-1')).toBe(true)
    expect(sessions.hasSession(instance, 'fixture_session=accepted-2')).toBe(true)
    sessions.forgetSession(instance)
    expect(sessions.hasSession(instance, 'fixture_session=accepted-2')).toBe(false)
  } finally { await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) }) }
})
