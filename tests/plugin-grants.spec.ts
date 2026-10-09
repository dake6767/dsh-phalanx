import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginGrants } from '../src/adapters/plugin-grants.js'
it('persists grants and recovers references left by an interrupted group deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-grants-'))
  try {
    const path = join(root, 'grants.json'); const grants = new FilePluginGrants(path)
    grants.set('retained', ['one', 'two']); grants.set('removed', ['one'])
    const recovered = new FilePluginGrants(path); recovered.retainGroups(['retained'])
    expect(recovered.get('removed')).toEqual([])
    expect(new FilePluginGrants(path).get('retained')).toEqual(['one', 'two'])
    recovered.remove('retained'); expect(new FilePluginGrants(path).get('retained')).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
