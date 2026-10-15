import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'

it('runs an explicitly local development model through the Messages HTTP seam without external credentials', async () => {
  const child = spawn(process.execPath, ['scripts/dev/model.mjs', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stderr.on('data', chunk => { errors += String(chunk) })
  try {
    const address = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += String(chunk)
        const match = /^Development model: (http:\/\/127\.0\.0\.1:\d+)\n/.exec(output)
        if (match) resolve(match[1]!)
      })
      child.once('exit', code => reject(new Error(`Model exited ${code}: ${errors}`)))
    })
    const response = await fetch(`${address}/anthropic/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'development-only-fixture' },
      body: JSON.stringify({ model: 'development-model', messages: [{ role: 'user', content: 'hello' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('Local development model is ready')
    expect(body).toContain('Configure a real model in Administration')
    expect(body).toContain('event: message_stop')
    expect((await fetch(`${address}/unrelated`)).status).toBe(404)
    expect(output + errors).not.toContain('development-only-fixture')
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
  }
})
