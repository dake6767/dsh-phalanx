import { dshProfileWriterLoader } from '../../src/dsh/profile-writer.js'

/** Exercise the installed DSH writer and hold its critical section for a real SIGKILL. */
export const memberProfileLockModule = `
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
${dshProfileWriterLoader}
export const name = 'member-profile-lock-acceptance'
export const inject = ['webServer', 'profileContext']
export async function apply(ctx) {
  const { withFileLock, writeFileAtomic } = await loadDshProfileWriter(createRequire(process.argv[1]), pathToFileURL)
  const profile = ctx.profileContext.dir
  const manifest = join(profile, 'package.json')
  let release, writer
  ctx.effect(() => async () => {
    if (!release || !writer) return
    await delay(1500)
    release()
    await writer
    await writeFile(join(profile, 'graceful-lock-fixture'), 'released', { mode: 0o600 })
  })
  const read = async () => {
    try { return JSON.parse(await readFile(manifest, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { private: true }
    }
  }
  const holdLock = async graceful => {
    const committed = Promise.withResolvers()
    const hold = new Promise(resolve => { if (graceful) release = resolve })
    writer = withFileLock(manifest, async () => {
      const value = await read()
      await writeFileAtomic(manifest, JSON.stringify({ ...value, phalanxAcceptance: 'retained' }) + '\\n', { mode: 0o600 })
      committed.resolve({ pid: process.pid, committed: 'retained' })
      await hold
    })
    void writer.catch(committed.reject)
    return await committed.promise
  }
  const holdOnStart = await readFile(join(process.env.HOME, 'profile-lock-at-start'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  if (holdOnStart === 'hold') await holdLock(true)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/profile-write-lock-fixture',
    handler: async (request, response) => {
      const reply = value => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(value))
      }
      try {
        if (request.method !== 'POST') return reply({ pid: process.pid, committed: (await read()).phalanxAcceptance })
        const requestUrl = new URL(request.url, 'http://127.0.0.1')
        reply(await holdLock(requestUrl.searchParams.has('graceful')))
      } catch (error) {
        response.statusCode = 500
        reply({ error: error.message })
      }
    },
  }))
}
`
