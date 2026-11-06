import { expect, it } from 'vitest'
import type { CommunityPluginView } from '../src/domain/admin-contract.js'
import { npmPluginSource, type LibraryPlugin, type PluginCandidate, type PluginSource } from '../src/domain/plugin-library.js'
import { receivePluginUpload } from '../src/use-cases/plugin-library-upload.js'
import { KeyedOperations } from '../src/use-cases/support/keyed-operations.js'

const actor = { username: 'admin', spaceId: 'space-admin', sessionEpoch: 1 }
const view = (packageName: string): CommunityPluginView => ({ packageName }) as CommunityPluginView

function fixture(rows: LibraryPlugin[] = []) {
  const enqueued: LibraryPlugin[] = [],
    replaced: PluginCandidate[] = [],
    accepted: string[] = [],
    discarded: string[] = []
  let failAccept = false
  const owner = {
    assertAdmin: async () => {},
    assertIdle: () => {},
    assertWritable: async () => {},
    stopped: () => false,
    operations: new KeyedOperations(),
    store: { list: async () => rows },
    enqueue: async (row: LibraryPlugin) => {
      enqueued.push(row)
      return view(row.packageName)
    },
    enqueueReplacement: async (input: PluginCandidate) => {
      replaced.push(input)
      return view(input.packageName)
    },
  }
  const uploads = {
    accept: async (filename: string) => {
      if (failAccept) throw Error('accept failed')
      accepted.push(filename)
      return { packageName: 'skin', version: '2.0.0', archive: '/archives/a.tgz', integrity: 'sha512-new' }
    },
    discard: async (archive: string) => {
      discarded.push(archive)
    },
  }
  const receive = (replacing?: string) =>
    receivePluginUpload(owner, uploads, actor, 'skin.tgz', (async function* () {})(), new AbortController().signal, replacing)
  return { rows, enqueued, replaced, accepted, discarded, receive, failAccept: (value: boolean) => (failAccept = value) }
}

const row = (over: Partial<LibraryPlugin>): LibraryPlugin =>
  ({ packageName: 'skin', source: npmPluginSource, version: '1.0.0', stage: 'available', current: null, published: false, ...over }) as LibraryPlugin

it('enqueues a first upload as a new library row and releases the archive when acceptance fails', async () => {
  const state = fixture()
  expect(await state.receive()).toMatchObject({ packageName: 'skin' })
  expect(state.enqueued).toMatchObject([{ packageName: 'skin', version: '2.0.0', source: { kind: 'upload' }, upload: { archive: '/archives/a.tgz' } }])
  expect(state.discarded).toEqual([])
  state.failAccept(true)
  await expect(state.receive()).rejects.toThrow('accept failed')
  expect(state.discarded).toEqual([])
})

it('routes a replacement to the replacement precheck and refuses same-version different content before it', async () => {
  const existing = row({
    source: { kind: 'upload' } as PluginSource,
    version: '1.0.0',
    current: {
      packageName: 'skin',
      version: '1.0.0',
      integrity: 'sha512-old',
      artifact: 'a',
      runtimeRevision: 'r',
      title: 't',
      description: 'd',
      bundlePatch: '[]',
      dependencies: {},
    },
    identities: { '2.0.0': 'sha512-known' },
  })
  const state = fixture([existing])
  await expect(state.receive('skin')).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  expect(state.replaced).toEqual([])
  expect(state.discarded).toEqual(['/archives/a.tgz'])
  state.rows[0] = row({
    source: { kind: 'upload' } as PluginSource,
    version: '1.0.0',
    current: {
      packageName: 'skin',
      version: '1.0.0',
      integrity: 'sha512-old',
      artifact: 'a',
      runtimeRevision: 'r',
      title: 't',
      description: 'd',
      bundlePatch: '[]',
      dependencies: {},
    },
  })
  expect(await state.receive('skin')).toMatchObject({ packageName: 'skin' })
  expect(state.replaced).toMatchObject([{ packageName: 'skin', version: '2.0.0', upload: { integrity: 'sha512-new' } }])
  expect(state.discarded).toEqual(['/archives/a.tgz'])
})

it('keeps an existing identical upload and refuses a different version without enqueueing', async () => {
  const state = fixture([
    row({
      source: { kind: 'upload' } as PluginSource,
      version: '2.0.0',
      upload: { archive: '/archives/old.tgz', integrity: 'sha512-new' },
    }),
  ])
  expect(await state.receive()).toMatchObject({ packageName: 'skin' })
  expect(state.enqueued).toEqual([])
  // The identical re-upload keeps the row and releases its redundant archive.
  expect(state.discarded).toEqual(['/archives/a.tgz'])
  state.rows[0] = row({
    source: { kind: 'upload' } as PluginSource,
    version: '3.0.0',
    upload: { archive: '/archives/old.tgz', integrity: 'sha512-new' },
  })
  await expect(state.receive()).rejects.toMatchObject({ code: 'plugin-name-in-use' })
  expect(state.enqueued).toEqual([])
  expect(state.discarded).toEqual(['/archives/a.tgz', '/archives/a.tgz'])
})
