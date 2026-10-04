import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const path = join(process.env.RELEASE_FIXTURE_ROOT, 'registry.json')
if (process.argv[2] === '--copy') {
  const state = JSON.parse(await readFile(path, 'utf8'))
  const destination = process.argv.at(-1)
  if (!process.argv.includes('--preserve-digests') || !destination.startsWith('docker://ghcr.io/dake6767/dsh-phalanx:')) throw new Error('Unexpected registry copy')
  state.tags[destination.split(':').at(-1)] = state.digest
  state.copies += 1
  await writeFile(path, JSON.stringify(state))
} else {
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input)
    const state = JSON.parse(await readFile(path, 'utf8'))
    if (url.origin !== 'https://ghcr.io') throw new Error('Unexpected registry host')
    if (url.pathname === '/token') {
      if (!options.headers?.authorization) state.anonymousReads += 1
      await writeFile(path, JSON.stringify(state))
      return globalThis.Response.json({ token: 'fictional-registry-token' })
    }
    if (!url.pathname.startsWith('/v2/dake6767/dsh-phalanx/manifests/')) throw new Error('Unexpected registry path')
    const digest = state.tags[url.pathname.split('/').at(-1)]
    return new globalThis.Response(null, { status: digest ? 200 : 404, headers: digest ? { 'docker-content-digest': digest } : {} })
  }
}
