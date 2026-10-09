import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginUpstreams } from '../src/adapters/plugin-upstreams.js'
it('retains platform-only credentials atomically with mode 0600 across restart and deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-upstreams-')); const path = join(root, 'plugin-upstreams.json')
  try {
    const store = new FilePluginUpstreams(path)
    store.save('@sample/plugin', [{ name: 'search', baseUrl: 'http://localhost', credential: 'fictional-private-key', headers: [] }])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(new FilePluginUpstreams(path).list('@sample/plugin')[0]?.credential).toBe('fictional-private-key')
    store.save('@sample/plugin', [])
    expect(readFileSync(path, 'utf8')).not.toContain('fictional-private-key')
    expect(new FilePluginUpstreams(path).list('@sample/plugin')).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
