import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginSelections } from '../src/adapters/plugin-selections.js'
it('persists independent space choices and removes retired packages without changing other selections', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-selections-')), path = join(root, 'selections.json')
  try {
    const store = new FilePluginSelections(path)
    store.set('space-a', ['one', 'two', 'one']); store.set('space-b', ['two'])
    expect(store.get('space-a')).toEqual(['one', 'two']); expect(store.members('two')).toEqual(['space-a', 'space-b'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const reopened = new FilePluginSelections(path); expect(reopened.get('space-a')).toEqual(['one', 'two'])
    expect(reopened.get('new-space-a')).toEqual([])
    reopened.removePackage('one'); expect(reopened.get('space-a')).toEqual(['two'])
    reopened.retainPackages([]); expect(new FilePluginSelections(path).members('two')).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
