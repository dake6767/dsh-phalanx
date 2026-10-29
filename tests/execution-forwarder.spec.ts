import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { executionForwarderSource, executionStub } from '../src/adapters/execution-forwarder.js'

it('generated native command, shell, Python and JS stubs preserve binary streams and never forward the member environment', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'execution-forwarder-')))
  const received: unknown[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      expect(req.headers['x-api-key']).toBe('member-access-token')
      const body = JSON.parse(Buffer.concat(chunks).toString())
      received.push(body)
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ stream: 'stdout', data: body.stdin }) + '\n')
      res.write(JSON.stringify({ stream: 'stderr', data: Buffer.from('diagnostic\0').toString('base64') }) + '\n')
      res.end(JSON.stringify({ exit: 7 }) + '\n')
    })().catch(error => {
      res.destroy(error)
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error()
  try {
    const dispatch = join(root, 'dispatch.mjs')
    await writeFile(dispatch, executionForwarderSource())
    for (const [command, interpreter] of [
      ['news-cli', '/bin/sh'],
      ['script.sh', '/bin/sh'],
      ['script.py', 'python3'],
      ['script.mjs', process.execPath],
    ]) {
      const stub = join(root, command!)
      await writeFile(stub, executionStub(dispatch, 'skill:news', command!))
      const child = spawn(interpreter!, [stub, 'hot', 'with spaces', '中文'], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          DSH_PHALANX_MODEL_GATEWAY_URL: `http://127.0.0.1:${address.port}/model`,
          DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: 'member-access-token',
          MEMBER_SECRET: 'must-not-be-forwarded',
        },
      })
      const stdout: Buffer[] = [],
        stderr: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.stdin.end(Buffer.from([0, 255, 1, 10, 128]))
      const code = await new Promise<number | null>((done, fail) => {
        child.on('error', fail)
        child.on('close', done)
      })
      expect(code, Buffer.concat(stderr).toString()).toBe(7)
      expect(Buffer.concat(stdout)).toEqual(Buffer.from([0, 255, 1, 10, 128]))
      expect(Buffer.concat(stderr).toString()).toBe('diagnostic\0')
      expect(received.at(-1)).toEqual({
        owner: 'skill:news',
        command,
        argv: ['hot', 'with spaces', '中文'],
        cwd: root,
        stdin: Buffer.from([0, 255, 1, 10, 128]).toString('base64'),
      })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
})
