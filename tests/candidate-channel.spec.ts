import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { publishCandidateChannel, clearCandidateChannel } from '../scripts/release/candidate-channel.mjs'

const repository = 'repos/dake6767/dsh-phalanx-candidates/contents',
  filename = 'candidate-channel.json'
const index = (run: string, targetVersion = '0.1.27') => ({
  schema: 1,
  candidate: `run-${run}`,
  targetVersion,
  commit: 'b'.repeat(40),
  manifestSha256: createHash('sha256')
    .update(targetVersion + ':' + run)
    .digest('hex'),
})

/** A content API port with real revision conflicts and durable writes before lost responses. */
function contentApi(initial?: unknown) {
  let value = initial,
    attempts = 0,
    commits = 0,
    before: (() => void) | undefined,
    after: (() => void) | undefined
  const bytes = () => Buffer.from(JSON.stringify(value, null, 2) + '\n')
  const sha = () => (value === undefined ? undefined : createHash('sha1').update(`blob ${bytes().length}\0`).update(bytes()).digest('hex'))
  return {
    value: () => value,
    attempts: () => attempts,
    commits: () => commits,
    set: (next: unknown) => {
      value = next
    },
    beforeWrite: (run: () => void) => {
      before = run
    },
    afterWrite: (run: () => void) => {
      after = run
    },
    request(path: string, options: string[] = []): unknown {
      if (path === `${repository}?ref=main`) return value === undefined ? [] : [{ name: filename, type: 'file' }]
      if (path === `${repository}/${filename}?ref=main`)
        return { type: 'file', name: filename, path: filename, encoding: 'base64', sha: sha(), size: bytes().length, content: bytes().toString('base64') }
      if (path !== `${repository}/${filename}` || !options.includes('PUT')) throw Error('Unexpected content request')
      const body = JSON.parse(readFileSync(options[options.indexOf('--input') + 1]!, 'utf8'))
      attempts += 1
      const preparing = before
      before = undefined
      preparing?.()
      if (body.sha !== sha() || body.branch !== 'main') throw Error('Content revision conflict')
      value = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
      commits += 1
      const completed = after
      after = undefined
      completed?.()
      return { content: { sha: sha() } }
    },
  }
}

function publish(value: ReturnType<typeof index>, port: ReturnType<typeof contentApi>) {
  return publishCandidateChannel({ tag: value.candidate, targetVersion: value.targetVersion, commit: value.commit }, value.manifestSha256, port.request)
}

it('does not replace a newer version or run and does not recommit the same public identity', async () => {
  const port = contentApi()
  await publish(index('100', '0.1.28'), port)
  await publish(index('1000'), port)
  await publish(index('101', '0.1.28'), port)
  await publish(index('99', '0.1.28'), port)
  await publish(index('101', '0.1.28'), port)
  expect(port.value()).toEqual(index('101', '0.1.28'))
  expect(port.commits()).toBe(2)
})

it('preserves a concurrent newer publication after the content revision rejects an older writer', async () => {
  const port = contentApi(index('100'))
  port.beforeWrite(() => port.set(index('300', '0.1.28')))
  await publish(index('200'), port)
  expect(port.value()).toEqual(index('300', '0.1.28'))
  expect(port.attempts()).toBe(1)
  expect(port.commits()).toBe(0)
})

it('recognizes a committed write after its response is lost without another commit', async () => {
  const port = contentApi(index('100'))
  port.afterWrite(() => {
    throw Error('Response lost')
  })
  await publish(index('200'), port)
  expect(port.value()).toEqual(index('200'))
  expect(port.attempts()).toBe(1)
  expect(port.commits()).toBe(1)
})

it('does not blindly retry a failed write whose content revision did not change', async () => {
  const port = contentApi(index('100'))
  port.beforeWrite(() => {
    throw Error('Connection unavailable')
  })
  await expect(publish(index('200'), port)).rejects.toThrow('Connection unavailable')
  expect(port.value()).toEqual(index('100'))
  expect(port.attempts()).toBe(1)
})

it('rejects malformed or conflicting channel identities before writing', async () => {
  for (const initial of [
    { ...index('100'), candidate: ['run-100'] },
    { ...index('200'), manifestSha256: 'f'.repeat(64) },
  ]) {
    const port = contentApi(initial)
    await expect(publish(index('200'), port)).rejects.toThrow()
    expect(port.value()).toEqual(initial)
    expect(port.commits()).toBe(0)
  }
})

it('does not clear a concurrent publication while withdrawing an owned cleanup selection', async () => {
  const port = contentApi(index('100'))
  port.beforeWrite(() => port.set(index('300')))
  await clearCandidateChannel([{ tag: 'run-100', targetVersion: '0.1.27' }], port.request)
  expect(port.value()).toEqual(index('300'))
  expect(port.commits()).toBe(0)
})
