import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { pluginArtifactPreparation } from '../src/dsh/plugin-preparation.js'
import { execFileText } from '../src/adapters/runtime-command.js'

it('downloads redirecting registry archives and rejects changed bytes or an unrelated redirect destination', async () => {
  const bytes = Buffer.from('fixture archive bytes'),
    integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  let behavior = 'valid',
    origin = ''
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    if (request.url === '/fixture/1.0.0') response.end(JSON.stringify({ name: 'fixture', version: '1.0.0', dist: { integrity, tarball: origin + '/archive' } }))
    else if (request.url === '/archive') {
      response.writeHead(302, { location: behavior === 'unrelated' ? 'http://example.invalid/private' : '/bytes' })
      response.end()
    } else {
      response.end(behavior === 'tampered' ? 'changed' : bytes)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const root = await mkdtemp(join(tmpdir(), 'plugin-registry-'))
  try {
    const control = join(root, 'control'),
      work = join(root, 'work')
    await mkdir(control)
    await mkdir(work)
    await writeFile(join(control, 'input.json'), JSON.stringify({ registry: origin, packageName: 'fixture', version: '1.0.0' }))
    // Substitute the two container mount locations at this process/filesystem seam.
    await writeFile(join(control, 'prepare.mjs'), pluginArtifactPreparation.replaceAll('/control/', control + '/').replaceAll('/prepare/', work + '/'))
    for (behavior of ['valid', 'tampered', 'unrelated']) {
      requests.length = 0
      const run = execFileText(process.execPath, [join(control, 'prepare.mjs'), 'download'])
      if (behavior === 'valid') {
        await run
        expect(await readFile(join(work, 'original.tgz'))).toEqual(bytes)
        expect(requests).toEqual(['/fixture/1.0.0', '/archive', '/bytes'])
      } else {
        await expect(run).rejects.toThrow()
        expect(JSON.parse(await readFile(join(work, 'failure.json'), 'utf8')).code).toBe(
          behavior === 'tampered' ? 'plugin-integrity-invalid' : 'plugin-package-invalid',
        )
        if (behavior === 'unrelated') expect(requests).toEqual(['/fixture/1.0.0', '/archive'])
      }
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
