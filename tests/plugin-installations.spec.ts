import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginInstallations } from '../src/adapters/plugin-installations.js'

it('persists successful deliveries by immutable member space and keeps independent package histories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-installations-')), path = join(root, 'records.json')
  try {
    const records = new FilePluginInstallations(path)
    records.save('space-a', { packageName: 'plugin', source: 'preinstall', version: '1.0.0' })
    records.save('space-a', { packageName: 'other', source: 'selected', version: '2.0.0' })
    records.save('space-b', { packageName: 'plugin', source: 'selected', version: '3.0.0' })
    const reopened = new FilePluginInstallations(path)
    expect(reopened.get('space-a')).toEqual([{ packageName: 'other', source: 'selected', version: '2.0.0' }, { packageName: 'plugin', source: 'preinstall', version: '1.0.0' }])
    expect(reopened.get('space-b')).toEqual([{ packageName: 'plugin', source: 'selected', version: '3.0.0' }])
    expect(reopened.get('new-space')).toEqual([])
    reopened.save('space-a', { packageName: 'plugin', source: 'selected', version: '1.2.0' })
    expect(new FilePluginInstallations(path).get('space-a')).toContainEqual({ packageName: 'plugin', source: 'selected', version: '1.2.0' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    reopened.clearPreinstalls('space-a')
    expect(new FilePluginInstallations(path).get('space-a')).toEqual([{ packageName: 'other', source: 'selected', version: '2.0.0' }, { packageName: 'plugin', source: 'selected', version: '1.2.0' }])
    reopened.save('space-a', { packageName: 'preinstalled', source: 'preinstall', version: '1.0.0' })
    reopened.clearPreinstalls('space-a')
    expect(new FilePluginInstallations(path).get('space-a').map(row => row.packageName)).toEqual(['other', 'plugin'])
    expect(new FilePluginInstallations(path).get('space-b')).toEqual([{ packageName: 'plugin', source: 'selected', version: '3.0.0' }])
  } finally { await rm(root, { recursive: true, force: true }) }
})
