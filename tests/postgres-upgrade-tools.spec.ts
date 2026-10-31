import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'

const responses = vi.hoisted(() => new Map<string, string>())
const invoked = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', () => ({
  spawn: (_executable: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true })
    invoked.push(args)
    queueMicrotask(() => {
      const output = responses.get(JSON.stringify(args))
      if (output !== undefined) child.stdout.write(output)
      child.stdout.end()
      child.emit('close', output === undefined ? 1 : 0)
    })
    return child
  },
}))
import { preparePostgresUpgradeTools } from '../src/adapters/postgres-upgrade-tools.js'

const pin = { image: 'docker.io/library/postgres:17.11-bookworm', digest: 'sha256:' + 'b'.repeat(64) }
const fixed = 'sha256:' + 'a'.repeat(64)
function cached(reference: string, digest = pin.digest) {
  responses.set(
    JSON.stringify(['image', 'inspect', reference]),
    JSON.stringify([{ Id: fixed, Digest: digest, Os: 'linux', Architecture: process.arch === 'arm64' ? 'arm64' : 'amd64' }]),
  )
}
function versions(major: number) {
  for (const tool of ['pg_dump', 'pg_restore'])
    responses.set(JSON.stringify(['run', '--rm', '--pull=never', '--network=none', fixed, tool, '--version']), `${tool} (PostgreSQL) ${major}.11\n`)
}
beforeEach(() => {
  responses.clear()
  invoked.length = 0
})
it('reuses the verified cached pin for an external server of the same major without downloading another tag', async () => {
  cached('docker.io/library/postgres@' + pin.digest)
  versions(17)
  await expect(preparePostgresUpgradeTools(17, 'external', pin)).resolves.toEqual({ image: fixed, digest: pin.digest, major: 17 })
  expect(invoked.some(args => args[0] === 'pull')).toBe(false)
})
it.each(['missing', 'wrong-digest'])('uses the official same-major cache when the known pin is %s', async state => {
  const digest = 'sha256:' + 'c'.repeat(64)
  if (state === 'wrong-digest') cached('docker.io/library/postgres@' + pin.digest, digest)
  cached('docker.io/library/postgres:17-bookworm', digest)
  versions(17)
  await expect(preparePostgresUpgradeTools(17, 'external', pin)).resolves.toEqual({ image: fixed, digest, major: 17 })
  expect(invoked.some(args => args[0] === 'pull')).toBe(false)
})
it('obtains tools of an external server major through its configured source instead of reusing a different major pin', async () => {
  cached('docker.io/library/postgres@' + pin.digest)
  const transport = 'mirror.example/library/postgres:14-bookworm',
    digest = 'sha256:' + 'c'.repeat(64)
  responses.set(JSON.stringify(['pull', '--quiet', transport]), '')
  cached(transport, digest)
  versions(14)
  await expect(preparePostgresUpgradeTools(14, 'external', pin, 'https://mirror.example/')).resolves.toEqual({ image: fixed, digest, major: 14 })
  expect(invoked).toContainEqual(['pull', '--quiet', transport])
  expect(invoked).not.toContainEqual(['image', 'inspect', 'docker.io/library/postgres@' + pin.digest])
})
it('rejects an invalid built-in pin without falling back to a mutable major tag', async () => {
  cached('docker.io/library/postgres@' + pin.digest, 'sha256:' + 'c'.repeat(64))
  await expect(preparePostgresUpgradeTools(17, 'builtin', pin)).rejects.toThrow('digest or platform differs')
  expect(invoked).toEqual([['image', 'inspect', 'docker.io/library/postgres@' + pin.digest]])
})
