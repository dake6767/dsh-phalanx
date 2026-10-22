import { expect, it } from 'vitest'
import { preinstallCandidates } from '../src/domain/plugin-preinstall.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'

const plugin = (packageName: string): PreparedPlugin => ({ packageName, version: '1.0.0', integrity: 'sha512-fixture', artifact: 'artifacts/' + packageName,
  runtimeRevision: 'revision', title: packageName, description: '', bundlePatch: '[]', dependencies: {} })
const library = (name: string, change: Partial<LibraryPlugin> = {}): LibraryPlugin => ({ ...plugin(name), current: plugin(name), stage: 'available', published: false, ...change })
const input = () => ({ account: { groupId: 'members', disabled: false }, groupId: 'members', packages: ['one', 'two'], deliveries: [] as { packageName: string }[],
  installed: [] as string[], library: [library('one'), library('two')], runtimeRevision: 'revision' })
const names = (value: ReturnType<typeof input>) => preinstallCandidates(value).map(row => row.packageName)

it('offers checked group packages once without requiring publication and preserves the checked version', () => {
  const value = input()
  expect(names(value)).toEqual(['one', 'two'])
  expect(preinstallCandidates(value)[0]).toMatchObject({ version: '1.0.0', integrity: 'sha512-fixture' })
  value.deliveries = [{ packageName: 'one' }]
  expect(names(value)).toEqual(['two'])
  // Removing the native copy does not erase the successful delivery.
  value.installed = ['one']; expect(names(value)).toEqual(['two'])
  value.installed = []; expect(names(value)).toEqual(['two'])
  value.packages = ['two']; expect(names(value)).toEqual(['two'])
  value.packages = ['one', 'two']; expect(names(value)).toEqual(['two'])
})

it('leaves independent native copies alone and adds only undelivered packages after a group transfer', () => {
  const value = input(); value.installed = ['one']
  expect(names(value)).toEqual(['two'])
  value.deliveries = [{ packageName: 'one' }]; value.installed = []
  value.account.groupId = 'other'
  expect(names(value)).toEqual([])
  value.groupId = 'other'; value.packages = ['one', 'three']; value.library.push(library('three'))
  expect(names(value)).toEqual(['three'])
  expect(value.deliveries).toEqual([{ packageName: 'one' }])
})

it('does not offer packages for disabled or departed accounts or unavailable checked artifacts', () => {
  const value = input(); value.account.disabled = true
  expect(names(value)).toEqual([])
  expect(preinstallCandidates({ ...value, account: undefined })).toEqual([])
  value.account.disabled = false
  value.library = [library('one', { removing: true }), library('two', { incompatible: true }), library('three', { stage: 'failed' }),
    library('four', { current: { ...plugin('four'), runtimeRevision: 'old' } }), library('five', { current: null })]
  value.packages = ['one', 'two', 'three', 'four', 'five', 'missing']
  expect(names(value)).toEqual([])
})
