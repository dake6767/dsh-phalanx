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

it('saves both plugin lists atomically and permits moving a package in one configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-grants-'))
  try {
    const path = join(root, 'grants.json'), store = new FilePluginGrants(path)
    store.configure('group', ['controlled'], ['native'])
    const reopened = new FilePluginGrants(path)
    expect(reopened.get('group')).toEqual(['controlled']); expect(reopened.preinstalls('group')).toEqual(['native'])
    reopened.configure('group', ['native'], ['controlled'])
    const moved = new FilePluginGrants(path)
    expect(moved.get('group')).toEqual(['native']); expect(moved.preinstalls('group')).toEqual(['controlled'])
    expect(() => moved.configure('group', ['native'], ['native'])).toThrow()
    expect(new FilePluginGrants(path).preinstalls('group')).toEqual(['controlled'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps preinstalls and contribution receipts during controlled edits, rejects implicit moves and cleans both lists on group removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-grants-'))
  try {
    const path = join(root, 'grants.json'), store = new FilePluginGrants(path), receipt = { id: 'contribution', revision: 'approved' }
    store.configure('retained', [], ['native']); store.configure('removed', [], ['native'])
    store.grantContribution('retained', 'controlled', receipt)
    store.set('retained', ['controlled', 'another'])
    const reopened = new FilePluginGrants(path)
    expect(reopened.preinstalls('retained')).toEqual(['native']); expect(reopened.contributionReceipt('retained', 'controlled')).toEqual(receipt)
    expect(() => reopened.set('retained', ['native'])).toThrow()
    expect(() => reopened.grantContribution('retained', 'native', receipt)).toThrow()
    reopened.retainGroups(['retained'])
    expect(new FilePluginGrants(path).preinstalls('removed')).toEqual([])
    reopened.remove('retained')
    const removed = new FilePluginGrants(path)
    expect(removed.preinstalls('retained')).toEqual([]); expect(removed.contributionReceipt('retained', 'controlled')).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
