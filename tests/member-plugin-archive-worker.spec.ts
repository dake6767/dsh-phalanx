import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { memberPluginArchiveWorker } from '../src/adapters/member-plugin-archive-worker.js'

it('retains only verified local archive bytes and rejects redirects, hash mismatch and overflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'member-archive-')), bytes = Buffer.from('checked archive bytes')
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  const server = createServer((request, response) => { if (request.url === '/redirect') response.writeHead(302, { location: '/archive' }).end(); else response.end(bytes) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Not listening')
  const run = async (directory: string, hash = integrity, maximum = 1024, path = '/archive') => {
    const child = spawn(process.execPath, ['-e', memberPluginArchiveWorker, `http://127.0.0.1:${address.port}${path}`, hash, String(maximum), directory], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.resume()
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    return { code, output }
  }
  try {
    const cache = join(root, 'cache'), result = await run(cache)
    expect(result.code).toBe(0); expect(await readFile(result.output)).toEqual(bytes)
    expect((await stat(cache)).mode & 0o777).toBe(0o700); expect((await stat(result.output)).mode & 0o777).toBe(0o600)
    for (const [directory, hash, maximum, path] of [
      ['mismatch', 'sha512-' + Buffer.alloc(64, 1).toString('base64'), 1024, '/archive'],
      ['overflow', integrity, bytes.length - 1, '/archive'], ['redirect', integrity, 1024, '/redirect'],
    ] as const) {
      expect((await run(join(root, directory), hash, maximum, path)).code).not.toBe(0)
      await expect(stat(join(root, directory))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readdir(cache)).toHaveLength(1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

it('acknowledges cancellation by exiting the worker before any cache file is committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'member-archive-cancel-')), cache = join(root, 'cache')
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve })
  const server = createServer((_request, response) => { response.writeHead(200); response.write('partial'); requested() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Not listening')
  const child = spawn(process.execPath, ['-e', memberPluginArchiveWorker, `http://127.0.0.1:${address.port}/archive`, 'sha512-' + Buffer.alloc(64, 1).toString('base64'), '1024', cache], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  const ended = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  try {
    await started; child.stdin.end('cancel\n')
    expect(await ended).not.toBe(0)
    await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
